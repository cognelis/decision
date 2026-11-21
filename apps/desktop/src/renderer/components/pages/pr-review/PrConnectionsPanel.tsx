import { useCallback, useEffect, useRef, useState } from "react";
import { prConnectionInputSchema, type PrConnection, type RetrievalAnswerProvider } from "@cognelis/decision-protocol";
import type { DecisionApi } from "../../../../shared/renderer-api.js";
import { ModalDialog } from "../../ModalDialog.js";
import { DesktopPageHeader } from "../DesktopPageHeader.js";
import { SettingsSubnav } from "../SettingsSubnav.js";
import { platformMessage } from "./platform-message.js";

export const PLATFORM_LABELS = { github: "GitHub", gitlab: "GitLab", "bitbucket-server": "Bitbucket Server / Data Center" } as const;
const PLATFORM_SHORT = { github: "GH", gitlab: "GL", "bitbucket-server": "BB" } as const;
const DEFAULT_URLS = { github: "https://github.com", gitlab: "https://gitlab.com", "bitbucket-server": "" } as const;
type Api = Pick<DecisionApi, "listPrConnections" | "savePrConnection" | "removePrConnection" | "checkPrConnection" | "openSurface" | "listAssistantModels" | "listPrCommentCandidates">;
/** A list typed with commas, full-width or not, or one per line. */
const authorList = (value: string): string[] => [...new Set(value.split(/[,，\n]/u).map((name) => name.trim()).filter(Boolean))];
type Check = { state: "checking" } | { state: "ok"; account: string } | { state: "error"; message: string };
type InvalidField = "pr-label" | "pr-base" | "pr-token" | "pr-skip-authors" | "pr-auto-daily";

export function PrConnectionsPanel({ api }: { api: Api }) {
  const [connections, setConnections] = useState<PrConnection[]>([]);
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const checkRuns = useRef(new Map<string, number>());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reload, setReload] = useState(0);
  const [editor, setEditor] = useState<{ existing?: PrConnection } | null>(null);
  const [removing, setRemoving] = useState<PrConnection | null>(null);
  const [platform, setPlatform] = useState<PrConnection["platform"]>("github");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState<string>(DEFAULT_URLS.github);
  const [token, setToken] = useState("");
  // The model reading this link's PR comments for decisions ("" when it does not), and authors it leaves out.
  const [recognitionProfile, setRecognitionProfile] = useState("");
  const [skipAuthors, setSkipAuthors] = useState("");
  // 自动预评审: the model ("" when off, as it starts) and the reviews a day at most.
  const [autoProfile, setAutoProfile] = useState("");
  const [dailyReviews, setDailyReviews] = useState("5");
  const [models, setModels] = useState<RetrievalAnswerProvider[]>([]);
  // Each reading link's last look at its PRs, and what stopped it, if anything did.
  const [looks, setLooks] = useState<Record<string, { checkedAt: string | null; error: string | null }>>({});
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState("");
  const [invalid, setInvalid] = useState<InvalidField | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let disposed = false;
    setLoading(true); setLoadError(false);
    void api.listPrConnections().then((items) => {
      if (!disposed) setConnections(items);
    }).catch(() => {
      if (!disposed) setLoadError(true);
    }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [api, reload]);

  // Named on each link that reads its comments, and offered in the editor.
  useEffect(() => { void api.listAssistantModels().then(setModels, () => setModels([])); }, [api]);
  useEffect(() => {
    void api.listPrCommentCandidates().then((result) => setLooks(Object.fromEntries(result.links.map(({ connectionId, ...look }) => [connectionId, look]))), () => undefined);
  }, [api, connections]);

  // Each link signs in with its own token whenever the list is read or saved; a link's newest check wins.
  const check = useCallback((id: string) => {
    const run = (checkRuns.current.get(id) ?? 0) + 1;
    checkRuns.current.set(id, run);
    const settle = (result: Check) => { if (checkRuns.current.get(id) === run) setChecks(current => ({ ...current, [id]: result })); };
    settle({ state: "checking" });
    api.checkPrConnection(id).then(({ account }) => settle({ state: "ok", account }), cause => settle({ state: "error", message: platformMessage(cause, "检查失败，请重试。") }));
  }, [api]);
  useEffect(() => { for (const item of connections) check(item.id); }, [connections, check]);

  const edit = (existing?: PrConnection) => {
    setRecognitionProfile(existing?.recognition?.profileId ?? ""); setSkipAuthors(existing?.recognition?.skipAuthors.join(", ") ?? "");
    setAutoProfile(existing?.autoReview?.profileId ?? ""); setDailyReviews(String(existing?.autoReview?.dailyReviews ?? 5));
    setPlatform(existing?.platform ?? "github"); setLabel(existing?.label ?? "");
    setBaseUrl(existing?.baseUrl ?? DEFAULT_URLS.github); setToken(""); setError(""); setMessage("");
    setEditor(existing ? { existing } : {});
  };
  const close = () => { setEditor(null); setRemoving(null); setToken(""); setError(""); };
  const tokenRequired = !editor?.existing || platform !== editor.existing.platform || baseUrl.trim() !== editor.existing.baseUrl;
  // As it opened: changed, Escape no longer closes it with the address and token typed.
  const untouched = platform === (editor?.existing?.platform ?? "github") && label === (editor?.existing?.label ?? "") &&
    baseUrl === (editor?.existing?.baseUrl ?? DEFAULT_URLS.github) && token === "" &&
    recognitionProfile === (editor?.existing?.recognition?.profileId ?? "") && skipAuthors === (editor?.existing?.recognition?.skipAuthors.join(", ") ?? "") &&
    autoProfile === (editor?.existing?.autoReview?.profileId ?? "") && dailyReviews === String(editor?.existing?.autoReview?.dailyReviews ?? 5);
  // A value refused is said on its field, and the field is where focus goes: said only below the form, a VoiceOver
  // user heard it once from 保存链接 and then looked for a field that said nothing.
  const refuse = (field: InvalidField, text: string) => {
    setError(text); setInvalid(field);
    document.getElementById(field)?.focus();
  };
  const invalidProps = (field: InvalidField) => {
    const refused = error !== "" && invalid === field;
    return { "aria-invalid": refused || undefined, "aria-describedby": refused ? "pr-connection-error" : undefined };
  };
  // Said under the field it is about, above that field's help (what a token needs stays in sight while one is asked for).
  const fieldError = (field: InvalidField) =>
    error !== "" && invalid === field ? <p className="form-field-error" role="alert" id="pr-connection-error">{error}</p> : null;
  const save = async () => {
    if (pending.current || !editor) return;
    setError(""); setInvalid(null);
    const parsed = prConnectionInputSchema.safeParse({ label: label.trim(), platform, baseUrl: baseUrl.trim(),
      ...(editor.existing ? { id: editor.existing.id } : {}), ...(token.trim() ? { token: token.trim() } : {}),
      ...(recognitionProfile ? { recognition: { profileId: recognitionProfile, skipAuthors: authorList(skipAuthors) } } : {}),
      ...(autoProfile ? { autoReview: { profileId: autoProfile, dailyReviews: Number(dailyReviews) } } : {}) });
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
      if (field === "recognition") { refuse("pr-skip-authors", "跳过的作者最多 20 个，每个名字不超过 300 个字符。"); return; }
      if (field === "autoReview") { refuse("pr-auto-daily", "每天的次数填 1 到 50 之间的整数。"); return; }
      refuse(field === "label" ? "pr-label" : field === "token" ? "pr-token" : "pr-base", "请填写链接名称和有效的 HTTPS 服务地址，地址不能包含账号密码、查询或片段；本机回环允许 HTTP。");
      return;
    }
    if (tokenRequired && !token.trim()) { refuse("pr-token", "新增链接或更换平台、服务地址时，请填写新的访问令牌。"); return; }
    pending.current = true; setSaving(true);
    try {
      setConnections(await api.savePrConnection(parsed.data));
      close(); setMessage("链接已保存。");
    } catch (caught) {
      // Whatever went wrong, it said to check a configuration: a keychain that refused the token among them.
      setError(`保存链接失败：${platformMessage(caught, String(caught))}`);
    }
    finally { pending.current = false; setSaving(false); }
  };
  const remove = async () => {
    if (!removing || pending.current) return;
    pending.current = true; setSaving(true); setError("");
    try {
      setConnections(await api.removePrConnection(removing.id));
      close(); setMessage("已移除本地链接。");
    } catch (caught) { setError(`移除链接失败：${platformMessage(caught, String(caught))}`); }
    finally { pending.current = false; setSaving(false); }
  };

  return <section className="desktop-view connections-panel" role="region" aria-label="链接">
    <DesktopPageHeader eyebrow="应用偏好" title="链接" description="管理 PR 评审使用的代码平台与访问令牌。" meta={loading || loadError ? "—" : connections.length} metaLabel="个链接" />
    <SettingsSubnav active="connections" api={api} />
    <div className="desktop-page-scroll connections-page-content">
      <section className="settings-card connections-card" aria-labelledby="connections-title" aria-busy={loading}>
        <header className="settings-card-header">
          <div><h2 id="connections-title">代码平台链接</h2>{loading || loadError ? null : <span>{connections.length} 个，最多 20 个</span>}</div>
          {/* The one thing to do on an empty page; beside a list of links it is one action among the rows'. */}
          <button type="button" className={!loading && !loadError && connections.length === 0 ? "primary-button" : "secondary-button"} disabled={loading || loadError || saving || connections.length >= 20} aria-haspopup="dialog" onClick={() => edit()}>
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4.5v11M4.5 10h11" /></svg>新增链接
          </button>
        </header>
        <p className="settings-card-description">PR 评审用这些链接浏览 PR、发表评论。支持私有部署；令牌只存在本机，存储方式遵循<button type="button" className="settings-inline-link" onClick={() => void api.openSurface("settings")}>通用 › 密钥存储</button>的设置。</p>
        {/* A read that failed is not an empty list: said in the danger colour where the links would be, with 重试. */}
        {loading ? <p className="connections-empty" role="status">正在读取链接…</p> : loadError ? <div className="load-failure" role="alert">
          <span>读取链接失败，请重试。</span><button type="button" className="secondary-button" onClick={() => setReload(value => value + 1)}>重试</button>
        </div> : connections.length === 0 ? <div className="connections-empty"><h3>尚未添加链接</h3><p>添加 GitHub、GitLab 或 Bitbucket，即可在 PR 评审中选择代码平台。</p></div> : <ul className="connections-list">
          {connections.map(item => { const status = checks[item.id]; return <li className="connection-row" key={item.id}>
            <span className="connection-icon" aria-hidden="true">{PLATFORM_SHORT[item.platform]}</span>
            <div className="connection-copy">
              <div className="connection-title"><h3>{item.label}</h3><span>{PLATFORM_LABELS[item.platform]} · {item.baseUrl}</span></div>
              {status ? <p className="connection-status" data-state={status.state}><span className="health-dot" aria-hidden="true" />{status.state === "checking" ? "正在检查…" : status.state === "ok" ? `已连接 · 账号 ${status.account}` : status.message}</p> : null}
              {item.recognition ? <p className="connection-recognition">识别评论里的决定 · {models.find((model) => model.profileId === item.recognition!.profileId)?.label ?? "已选模型"}
                {looks[item.id]?.error ? <span> · {looks[item.id]!.error}</span> : looks[item.id]?.checkedAt ? <span> · 上次查看 {new Date(looks[item.id]!.checkedAt!).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span> : null}</p> : null}
              {item.autoReview ? <p className="connection-recognition">自动预评审 · {models.find((model) => model.profileId === item.autoReview!.profileId)?.label ?? "已停用的模型"} · 每天最多 {item.autoReview.dailyReviews} 次</p> : null}
            </div>
            <div className="connection-actions">
              <button type="button" className="secondary-button" aria-label={`检查 ${item.label}`} disabled={status?.state === "checking"} onClick={() => check(item.id)}>检查</button>
              <button type="button" className="secondary-button" aria-label={`编辑 ${item.label}`} aria-haspopup="dialog" disabled={saving} onClick={() => edit(item)}>编辑</button>
              <button type="button" className="secondary-button danger-button" aria-label={`移除 ${item.label}`} aria-haspopup="dialog" disabled={saving} onClick={() => { setRemoving(item); setError(""); setMessage(""); }}>移除</button>
            </div>
          </li>; })}
        </ul>}
        {message ? <p className="settings-status" role="status">{message}</p> : null}
      </section>
    </div>
    {editor ? <ModalDialog title={editor.existing ? "编辑链接" : "新增链接"} description="配置代码平台及访问令牌" dismissible={!saving} unsaved={!untouched} onClose={close}
      footer={<><button type="button" className="secondary-button" disabled={saving} onClick={close}>取消</button><button className="primary-button" type="submit" form="connection-editor" disabled={saving}>{saving ? "正在保存…" : "保存链接"}</button></>}>
      <form id="connection-editor" onSubmit={event => { event.preventDefault(); void save(); }}>
        <fieldset className="form-fields" disabled={saving}>
          <div className="form-fields-row">
            <div className="form-field">
              <label htmlFor="pr-platform">代码平台</label>
              <select id="pr-platform" value={platform} onChange={event => { const value = event.target.value as PrConnection["platform"]; setPlatform(value); setBaseUrl(DEFAULT_URLS[value]); setToken(""); }}>
                {Object.entries(PLATFORM_LABELS).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
              </select>
            </div>
            <div className="form-field">
              <label htmlFor="pr-label">链接名称</label>
              <input id="pr-label" value={label} maxLength={100} required onChange={event => setLabel(event.target.value)} placeholder="例如：公司 GitLab" {...invalidProps("pr-label")} />
              {fieldError("pr-label")}
            </div>
          </div>
          <div className="form-field">
            <label htmlFor="pr-base">服务地址</label>
            <input id="pr-base" type="url" value={baseUrl} maxLength={2000} required onChange={event => { setBaseUrl(event.target.value); setToken(""); }} placeholder="https://code.example.com" {...invalidProps("pr-base")} />
            {fieldError("pr-base")}
          </div>
          <div className="form-field">
            <label htmlFor="pr-token">访问令牌</label>
            <input id="pr-token" type="password" value={token} maxLength={4000} required={tokenRequired} autoComplete="new-password" onChange={event => setToken(event.target.value)} aria-invalid={invalidProps("pr-token")["aria-invalid"]} aria-describedby={invalidProps("pr-token")["aria-invalid"] ? "pr-connection-error pr-token-help" : "pr-token-help"} />
            {fieldError("pr-token")}
            <p id="pr-token-help">{tokenRequired ? "浏览和 AI 评审只需读取权限；发布评论或使用 Approve、Need work、Merge 时，需要对应的平台写入权限。" : "留空保留已保存的令牌；更换平台或服务地址需填写新令牌。"}</p>
          </div>
          <hr className="form-fields-divider" />
          <div className="form-field">
            <label htmlFor="pr-recognition">识别 PR 评论里的决定</label>
            <select id="pr-recognition" value={recognitionProfile} aria-describedby="pr-recognition-help" onChange={event => setRecognitionProfile(event.target.value)}>
              <option value="">不识别</option>
              {/* Measured on real PRs (docs/benchmarks/pr-comment-recognition-2026-10-20): Claude Code read them best, a local model poorly. */}
              {models.map(model => <option key={model.profileId} value={model.profileId}>{model.label}{model.kind === "claude-code-cli" ? "（推荐）" : ""}{model.leavesDevice ? "（评论正文会发给服务商）" : "（本机，识别不准）"}</option>)}
              {recognitionProfile && !models.some(model => model.profileId === recognitionProfile) ? <option value={recognitionProfile}>已停用的模型</option> : null}
            </select>
            <p id="pr-recognition-help">选了模型，Paraself 会每 30 分钟看一次你评审和创建的开放 PR 上的新评论（第一次只看最近 7 天），把像是决定的列在首页「待确认」；在「PR 讨论」里也可以手动识别。识别出的评论由你确认后才记为决策。每个链接每天最多调用 20 次。</p>
          </div>
          {recognitionProfile ? <div className="form-field">
            <label htmlFor="pr-skip-authors">识别时跳过这些作者</label>
            <input id="pr-skip-authors" value={skipAuthors} maxLength={2000} placeholder="例如：ci-bot, review-bot" onChange={event => setSkipAuthors(event.target.value)} aria-invalid={invalidProps("pr-skip-authors")["aria-invalid"]} aria-describedby={invalidProps("pr-skip-authors")["aria-invalid"] ? "pr-connection-error pr-skip-authors-help" : "pr-skip-authors-help"} />
            {fieldError("pr-skip-authors")}
            <p id="pr-skip-authors-help">评审机器人、CI 账号的评论只作上下文，不花调用次数去识别。用逗号分隔，写全名或第一个词都可以。</p>
          </div> : null}
          <hr className="form-fields-divider" />
          <div className="form-field">
            <label htmlFor="pr-auto-review">自动预评审</label>
            <select id="pr-auto-review" value={autoProfile} aria-describedby="pr-auto-review-help" onChange={event => setAutoProfile(event.target.value)}>
              <option value="">不自动评审</option>
              {models.map(model => <option key={model.profileId} value={model.profileId}>{model.label}{model.leavesDevice ? "（PR 的改动会发给服务商）" : ""}</option>)}
              {autoProfile && !models.some(model => model.profileId === autoProfile) ? <option value={autoProfile}>已停用的模型</option> : null}
            </select>
            <p id="pr-auto-review-help">选了模型，Paraself 会每 30 分钟看一次待你评审的 PR：新的、或有了新提交的，自动评审一遍（高风险的用深度评审，之后只看新提交），打开时结果已经在评审页。一次评审一个；同一个 PR 评审过三轮后不再自动评审。结果只在本机，不会发到 PR 上。</p>
          </div>
          {autoProfile ? <div className="form-field">
            <label htmlFor="pr-auto-daily">每天最多评审几次</label>
            <input id="pr-auto-daily" type="number" inputMode="numeric" min={1} max={50} step={1} value={dailyReviews} onChange={event => setDailyReviews(event.target.value)} aria-invalid={invalidProps("pr-auto-daily")["aria-invalid"]} aria-describedby={invalidProps("pr-auto-daily")["aria-invalid"] ? "pr-connection-error pr-auto-daily-help" : "pr-auto-daily-help"} />
            {fieldError("pr-auto-daily")}
            <p id="pr-auto-daily-help">每次评审都会调用模型。今天用完了，余下的 PR 只列出，第二天再评。</p>
          </div> : null}
        </fieldset>
        {error !== "" && invalid === null ? <p className="form-error" role="alert" id="pr-connection-error">{error}</p> : null}
      </form>
    </ModalDialog> : null}
    {removing ? <ModalDialog title={`移除「${removing.label}」？`} size="compact" dismissible={!saving} onClose={close}
      footer={<><button type="button" className="secondary-button" autoFocus disabled={saving} onClick={close}>取消</button><button type="button" className="primary-button danger-button" disabled={saving} onClick={() => void remove()}>{saving ? "正在移除…" : "移除链接"}</button></>}>
      <p>本机保存的服务地址和访问令牌会一起删除。代码平台上的令牌不会被撤销，需要时请到平台上撤销。</p>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </ModalDialog> : null}
  </section>;
}
