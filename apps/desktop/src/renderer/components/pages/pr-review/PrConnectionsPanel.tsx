import { useCallback, useEffect, useRef, useState } from "react";
import { prConnectionInputSchema, type PrConnection } from "@cognelis/decision-protocol";
import type { DecisionApi } from "../../../../shared/renderer-api.js";
import { ModalDialog } from "../../ModalDialog.js";
import { DesktopPageHeader } from "../DesktopPageHeader.js";
import { SettingsSubnav } from "../SettingsSubnav.js";
import { platformMessage } from "./platform-message.js";

export const PLATFORM_LABELS = { github: "GitHub", gitlab: "GitLab", "bitbucket-server": "Bitbucket Server / Data Center" } as const;
const DEFAULT_URLS = { github: "https://github.com", gitlab: "https://gitlab.com", "bitbucket-server": "" } as const;
type Api = Pick<DecisionApi, "listPrConnections" | "savePrConnection" | "removePrConnection" | "checkPrConnection" | "openSurface">;
type Check = { state: "checking" } | { state: "ok"; account: string } | { state: "error"; message: string };
type InvalidField = "pr-label" | "pr-base" | "pr-token";

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
    setPlatform(existing?.platform ?? "github"); setLabel(existing?.label ?? "");
    setBaseUrl(existing?.baseUrl ?? DEFAULT_URLS.github); setToken(""); setError(""); setMessage("");
    setEditor(existing ? { existing } : {});
  };
  const close = () => { setEditor(null); setRemoving(null); setToken(""); setError(""); };
  const tokenRequired = !editor?.existing || platform !== editor.existing.platform || baseUrl.trim() !== editor.existing.baseUrl;
  // As it opened: changed, Escape no longer closes it with the address and token typed.
  const untouched = platform === (editor?.existing?.platform ?? "github") && label === (editor?.existing?.label ?? "") &&
    baseUrl === (editor?.existing?.baseUrl ?? DEFAULT_URLS.github) && token === "";
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
  const save = async () => {
    if (pending.current || !editor) return;
    setError(""); setInvalid(null);
    const parsed = prConnectionInputSchema.safeParse({ label: label.trim(), platform, baseUrl: baseUrl.trim(),
      ...(editor.existing ? { id: editor.existing.id } : {}), ...(token.trim() ? { token: token.trim() } : {}) });
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
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
      <section className="settings-card" aria-labelledby="connections-title" aria-busy={loading}>
        <header className="settings-card-header">
          <div><h2 id="connections-title">链接</h2></div>
          <button type="button" className="primary-button" disabled={loading || loadError || saving || connections.length >= 20} aria-haspopup="dialog" onClick={() => edit()}>新增链接</button>
        </header>
        {loading ? <p className="connections-empty" role="status">正在读取链接…</p> : loadError ? <div className="connections-empty">
          <p role="alert">读取链接失败，请重试。</p><button className="secondary-button" onClick={() => setReload(value => value + 1)}>重试</button>
        </div> : connections.length === 0 ? <div className="connections-empty"><h3>尚未添加链接</h3><p>添加 GitHub、GitLab 或 Bitbucket，即可在 PR 评审中选择代码平台。</p></div> : <ul className="connections-list">
          {connections.map(item => { const status = checks[item.id]; return <li className="connection-row" key={item.id}>
            <div className="connection-copy"><strong>{item.label}</strong><span>{PLATFORM_LABELS[item.platform]}</span><code>{item.baseUrl}</code>
              {status ? <p className="connection-status" data-state={status.state}><span className={`health-dot${status.state === "ok" ? " healthy" : ""}`} aria-hidden="true" />{status.state === "checking" ? "正在检查…" : status.state === "ok" ? `已连接 · 账号 ${status.account}` : status.message}</p> : null}</div>
            <div className="review-actions">
              <button type="button" className="secondary-button" aria-label={`检查 ${item.label}`} disabled={status?.state === "checking"} onClick={() => check(item.id)}>检查</button>
              <button type="button" className="secondary-button" aria-label={`编辑 ${item.label}`} aria-haspopup="dialog" disabled={saving} onClick={() => edit(item)}>编辑</button>
              <button type="button" className="secondary-button" aria-label={`移除 ${item.label}`} aria-haspopup="dialog" disabled={saving} onClick={() => { setRemoving(item); setError(""); setMessage(""); }}>移除</button>
            </div>
          </li>; })}
        </ul>}
      </section>
      <p className="connections-note">支持私有部署。令牌仅保存在本机，存储方式遵循「通用」中的密钥设置。{connections.length >= 20 ? "最多可保存 20 个链接。" : ""}</p>
    </div>
    {message ? <p className="settings-message" role="status">{message}</p> : null}
    {editor ? <ModalDialog title={editor.existing ? "编辑链接" : "新增链接"} description="配置代码平台及访问令牌" dismissible={!saving && untouched} onClose={close}>
      <form id="connection-editor" className="model-provider-dialog-form" onSubmit={event => { event.preventDefault(); void save(); }}>
        <fieldset className="connection-fields" disabled={saving}>
          <label htmlFor="pr-platform">代码平台</label>
          <select id="pr-platform" value={platform} onChange={event => { const value = event.target.value as PrConnection["platform"]; setPlatform(value); setBaseUrl(DEFAULT_URLS[value]); setToken(""); }}>
            {Object.entries(PLATFORM_LABELS).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
          </select>
          <label htmlFor="pr-label">链接名称</label><input id="pr-label" value={label} maxLength={100} required onChange={event => setLabel(event.target.value)} placeholder="例如：公司 GitLab" {...invalidProps("pr-label")} />
          <label htmlFor="pr-base">服务地址</label><input id="pr-base" type="url" value={baseUrl} maxLength={2000} required onChange={event => { setBaseUrl(event.target.value); setToken(""); }} placeholder="https://code.example.com" {...invalidProps("pr-base")} />
          <label htmlFor="pr-token">访问令牌</label><input id="pr-token" type="password" value={token} maxLength={4000} required={tokenRequired} autoComplete="new-password" onChange={event => setToken(event.target.value)} aria-invalid={invalidProps("pr-token")["aria-invalid"]} aria-describedby={invalidProps("pr-token")["aria-invalid"] ? "pr-connection-error pr-token-help" : "pr-token-help"} />
          <p id="pr-token-help">{tokenRequired ? "浏览和 AI 评审只需读取权限；发布评论或使用 Approve、Need work、Merge 时，需要对应的平台写入权限。" : "留空保留已保存的令牌；更换平台或服务地址需填写新令牌。"}</p>
        </fieldset>
        {error ? <p className="model-provider-dialog-error" role="alert" id="pr-connection-error">{error}</p> : null}
        <div className="modal-form-actions"><button type="button" className="secondary-button" disabled={saving} onClick={close}>取消</button><button className="primary-button" type="submit" disabled={saving}>{saving ? "正在保存…" : "保存链接"}</button></div>
      </form>
    </ModalDialog> : null}
    {removing ? <ModalDialog title="移除链接" size="compact" dismissible={!saving} onClose={close}>
      <p>移除「{removing.label}」的本地配置和令牌？服务器上的令牌不会被撤销。</p>
      {error ? <p role="alert">{error}</p> : null}
      <div className="modal-form-actions"><button className="secondary-button" disabled={saving} onClick={close}>取消</button><button className="primary-button" disabled={saving} onClick={() => void remove()}>{saving ? "正在移除…" : "确认移除"}</button></div>
    </ModalDialog> : null}
  </section>;
}
