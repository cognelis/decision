import { plainHeadline } from "../../question-title.js";
import { startOnboarding } from "../../../onboarding-navigation.js";
import { useEffect, useState } from "react";

import { clientNamesOr, knownClients, rememberClients, sourceLabel } from "../../../client-labels.js";
import type {
  AppSnapshot,
  ClientSummary,
  DecisionApi,
  DecisionLibraryItem,
} from "../../../../shared/renderer-api.js";
import { DesktopPageHeader } from "../DesktopPageHeader.js";
import { ModalDialog } from "../../ModalDialog.js";
import { SettingsSubnav } from "../SettingsSubnav.js";
import { keepSwitchFocus } from "../../../keyboard.js";

interface ClientsPanelProps {
  snapshot: AppSnapshot;
  api: DecisionApi;
}

const clientStatus = (
  status: AppSnapshot["integrationStatus"][string] | undefined,
  client: ClientSummary,
): { label: string; healthy: boolean; detail: string } => {
  if (status === "installed") {
    return {
      label: "已连接",
      healthy: true,
      detail: client.mcp === false
        ? "自动记录已启用；它没有注册 MCP，代理在给出选项前读不到原则。"
        : "自动记录已启用；代理也能在给出选项前读取相关原则与失败边界。",
    };
  }
  if (status === "not-installed") {
    return {
      label: "未连接",
      healthy: false,
      detail: "本机检测到了它，还没有接入；点「接入」装上自动记录和决策前原则核对。",
    };
  }
  if (status === "upgrade-required") {
    return {
      label: "需重新连接",
      healthy: false,
      detail: "接入配置与当前的 Paraself 不一致（App 被移动、升级到了新位置，或仍是旧版配置）；点「重新接入」。",
    };
  }
  if (status === "disabled") {
    return {
      label: "hook 已关闭",
      healthy: false,
      detail: client.id === "claude-code"
        ? "它的设置关掉了所有 hook（disableAllHooks），自动记录不会运行；在它的 settings.json 里去掉这一项并重启后才会恢复。"
        : "它的设置关掉了 Paraself 的 hook，自动记录不会运行；在它的 hook 配置里重新启用并重启后才会恢复。",
    };
  }
  if (status === "shadowed") {
    return {
      label: "未生效",
      healthy: false,
      detail: `${client.name} 现在读的是 ${client.shadowedBy ?? "另一份钩子文件"}，Paraself 写在它设置文件里的钩子不会运行；把那份文件里的钩子挪进设置文件的 hooks 并删掉它，再点「重新接入」。`,
    };
  }
  if (status === "command-missing") {
    return {
      label: "未检测到",
      healthy: false,
      detail: `没有找到 ${client.command} 命令；装好 ${client.name}、确认在终端里能运行 ${client.command} 后再接入。`,
    };
  }
  return {
    label: "待检查",
    healthy: false,
    detail: "没能读出接入配置，点「检查连接」看具体原因。",
  };
};

type InstallReport = Awaited<ReturnType<DecisionApi["installIntegrations"]>>;

const clientName = (id: string): string => sourceLabel(id);

/** What a check found: nothing is changed by it, so it says which clients would be. */
const checkedMessage = (report: InstallReport): string => {
  const stale = report.targets.filter((target) => target.changed).map((target) => clientName(target.client));
  // A file it could not read says so, and which, rather than the check failing for both clients.
  const unreadable = report.targets
    .filter((target) => target.status === "failed")
    .map((target) => `${clientName(target.client)} 的配置文件没法处理（${target.detail ?? "原因未知"}）`);
  const parts = [
    ...(stale.length === 0 ? [] : [`${stale.join("、")} 还没有接入或需要更新，可以点「全部修复」`]),
    ...unreadable,
  ];
  return parts.length === 0
    ? "检查完成，接入配置已是最新，没有修改。"
    : `检查完成，没有修改接入配置；${parts.join("；")}。`;
};

// A running client read its hooks and servers when it started: one connected or disconnected while it ran went on
// as it was, and the reader took the change for not working.
const restart = (clients = knownClients()): string => `重启正在运行的 ${clientNamesOr(clients)} 后生效。`;

/** The clients a report changed: those to restart. */
const changedClients = (report: InstallReport, status: "installed" | "removed") =>
  knownClients().filter((client) => report.targets.some((target) => target.client === client.id && target.status === status));

/** What an install did for each client: one can connect while the other is skipped or fails. */
const appliedMessage = (report: InstallReport): string => {
  const parts = report.targets.flatMap((target) =>
    target.status === undefined ? [] : [
      target.status === "installed"
        ? `${clientName(target.client)} 已接入${target.detail === undefined ? "" : `（${target.detail}）`}`
        : target.status === "skipped"
          ? `${target.detail ?? "没有找到命令"}，跳过了 ${clientName(target.client)}`
          : `${clientName(target.client)} 没有接上：${target.detail ?? "原因未知"}`,
    ]);
  return `${parts.length === 0 ? "接入已安装或修复。" : `${parts.join("；")}。`}${report.restartRequired && changedClients(report, "installed").length > 0 ? restart(changedClients(report, "installed")) : ""}`;
};

/** A client the check could not read, or the install could not connect: said in the danger colour, with the rest. */
const anyFailed = (report: InstallReport): boolean => report.targets.some((target) => target.status === "failed");
/** A client neither disconnected nor skipped for want of its command. */
const notRemoved = (report: InstallReport): boolean =>
  report.targets.some((target) => target.status !== "removed" && target.status !== "skipped");

/** What a disconnect did for each client, and what it leaves there: the skills published to it. */
const removedMessage = (report: InstallReport): string => {
  const parts = report.targets.map((target) =>
    target.status === "removed"
      ? `${clientName(target.client)} 已断开${target.detail === undefined ? "" : `（${target.detail}）`}`
      : target.status === "skipped"
        ? `${target.detail ?? "没有找到命令"}，跳过了 ${clientName(target.client)}`
        : `${clientName(target.client)} 没有断开：${target.detail ?? "原因未知"}`,
  );
  const removed = report.restartRequired && report.targets.some((target) => target.status === "removed");
  return `${parts.join("；")}。${removed ? restart(changedClients(report, "removed")) : ""}${report.note ?? ""}`;
};

/** Where a client's row goes: connected (this app's hooks are in its file), found on this machine, or not found. */
const groupOf = (status: AppSnapshot["integrationStatus"][string] | undefined): "connected" | "detected" | "other" =>
  status === "installed" || status === "upgrade-required" || status === "disabled" || status === "shadowed"
    ? "connected"
    : status === "command-missing"
      ? "other"
      : "detected";

type Row = ClientSummary & { mechanism: string; status: { label: string; healthy: boolean; detail: string } };

export const ClientsPanel = ({ snapshot, api }: ClientsPanelProps) => {
  rememberClients(snapshot.clients);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [rowMessages, setRowMessages] = useState<Record<string, { text: string; error: boolean }>>({});
  const rowBusy = (id: string): boolean => busy || pending[`client:${id}`] === true;
  const batchBusy = busy || Object.keys(pending).some((id) => id !== "check");
  // What a check, a repair or a disconnect did; a client it failed for puts the whole of it in the danger colour.
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [checkMessage, setCheckMessage] = useState<{ text: string; error: boolean } | null>(null);
  // Disconnecting takes the capture out: asked first, of every connected client or of one, its own failure said in the question.
  const [confirmingDisconnect, setConfirmingDisconnect] = useState<"all" | ClientSummary | null>(null);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  // One of the reader's own they asked to delete.
  const [deleting, setDeleting] = useState<ClientSummary | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // What each client last brought in: "connected" says the hook is installed, this says it works.
  const [latest, setLatest] = useState<Partial<Record<string, DecisionLibraryItem | null>>>({});

  // Every client the registry lists, the reader's own after the built-in ones and the catalog's.
  const clients: Row[] = snapshot.clients.map((client) => ({
    ...client,
    mechanism: client.mcp === false ? "Hooks" : "Hooks + MCP",
    // One of the reader's that did not pass the checks a save makes is not connected, and says why.
    status: client.problem === undefined
      ? clientStatus(snapshot.integrationStatus[client.id], client)
      : { label: client.superseded === true ? "不再生效" : "配置有问题", healthy: false, detail: `${client.problem}。` },
  }));
  const group = (client: Row) => (client.problem === undefined ? groupOf(snapshot.integrationStatus[client.id]) : "detected");
  const connected = clients.filter((client) => group(client) === "connected");
  const detected = clients.filter((client) => group(client) === "detected");
  const others = clients.filter((client) => group(client) === "other");
  // Only those on this machine are read for their latest decision: one not found has brought nothing in.
  const clientIds = [...connected, ...detected].map((client) => client.id).join(" ");
  useEffect(() => {
    let active = true;
    void Promise.all(clientIds.split(" ").filter(Boolean).map(async (source) =>
      [source, (await api.listDecisions({ query: "", sourceClient: source, limit: 1 }))[0] ?? null] as const,
    )).then(
      (found) => { if (active) setLatest(Object.fromEntries(found)); },
      () => undefined,
    );
    return () => {
      active = false;
    };
    // Read again as each decision comes in: read once, a client just connected and tested still said nothing had.
  }, [api, snapshot.dashboard.totalDecisions, clientIds]);
  const run = async (
    operation: () => Promise<InstallReport>,
    success: (report: InstallReport) => string,
    failed: (report: InstallReport) => boolean,
    thrown?: (text: string) => void,
    scope?: string,
  ): Promise<boolean> => {
    if (scope === undefined) setBusy(true);
    else setPending((current) => ({ ...current, [scope]: true }));
    const say = (value: { text: string; error: boolean } | null) => {
      if (scope === "check") setCheckMessage(value);
      else if (scope === undefined) setMessage(value);
      else setRowMessages((current) => {
        const { [scope]: _previous, ...rest } = current;
        return value === null ? rest : { ...rest, [scope]: value };
      });
    };
    say(null);
    try {
      const report = await operation();
      say({ text: success(report), error: failed(report) });
      return true;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (thrown) thrown(text);
      else say({ text, error: true });
      return false;
    } finally {
      if (scope === undefined) setBusy(false);
      else setPending(({ [scope]: _finished, ...rest }) => rest);
    }
  };
  // The page's actions act on the clients on this machine; a row's, on its own client.
  const onMachine = [...connected, ...detected].filter((client) => client.problem === undefined).map((client) => client.id);
  const connectedIds = connected.filter((client) => client.problem === undefined).map((client) => client.id);
  const disconnect = async (): Promise<void> => {
    const target = confirmingDisconnect;
    if (target === null) return;
    setDisconnectError(null);
    const ids = target === "all" ? connectedIds : [target.id];
    if (await run(() => api.removeIntegrations(ids), removedMessage, notRemoved, setDisconnectError, target === "all" ? undefined : `client:${target.id}`)) setConfirmingDisconnect(null);
  };
  const connect = (client: Row, button: HTMLButtonElement) =>
    keepSwitchFocus(button, run(() => api.installIntegrations("apply", [client.id]), appliedMessage, anyFailed, undefined, `client:${client.id}`));

  const deleteClient = async (client: ClientSummary) => {
    setDeleteError(null);
    setPending((current) => ({ ...current, [`client:${client.id}`]: true }));
    try {
      await api.deleteCustomClient(client.id);
      setDeleting(null);
      setMessage({ text: `已断开并删除 ${client.name}。`, error: false });
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, "") : String(error));
    } finally {
      setPending(({ [`client:${client.id}`]: _finished, ...rest }) => rest);
    }
  };

  const disconnectBusy = confirmingDisconnect === "all" ? busy : confirmingDisconnect !== null && rowBusy(confirmingDisconnect.id);
  const deleteBusy = deleting !== null && rowBusy(deleting.id);

  const connectedCount = clients.filter((client) => client.status.healthy).length;
  // A client not on this machine at all asks nothing of the reader.
  const attentionCount = [...connected, ...detected].filter((client) => !client.status.healthy).length;

  const row = (client: Row) => {
    const found = latest[client.id];
    // Where it comes from, in its key and its DOM ids: one of the reader's may share a catalog tool's id (superseded).
    const key = `${client.custom === true ? "custom" : client.untested === undefined ? "builtin" : "catalog"}-${client.id}`;
    const status = snapshot.integrationStatus[client.id];
    const hooked = client.problem === undefined && groupOf(status) === "connected";
    return (
      <article className="client-row" key={key} aria-labelledby={`client-${key}-name`}>
        <span className="client-row-icon" aria-hidden="true">
          {client.shortName}
        </span>
        {/* Side by side when there is room; in a narrow window the latest record goes under the text, not the icon. */}
        <div className="client-row-body">
          <div className="client-row-copy">
            <div className="client-row-title">
              <h3 id={`client-${key}-name`}>{client.name}</h3>
              {client.untested === undefined ? null : (
                // Written from its docs and source, not run on a real install: said beside its name, why on hover.
                <span className="client-untested-tag" title={client.untested} aria-label={`未实测：${client.untested}`} tabIndex={0}>
                  未实测
                </span>
              )}
              <span className={`client-status${client.status.healthy ? " healthy" : ""}`}>
                <span className="health-dot" aria-hidden="true" />
                {client.status.label}
              </span>
              <span className="client-row-actions">
                {client.custom === true ? (
                  <>
                    <span className="client-custom-tag">自定义</span>
                    <button type="button" className="text-button danger-button" aria-label={`删除 ${client.name}`} aria-haspopup="dialog" disabled={rowBusy(client.id)} onClick={() => { setDeleteError(null); setDeleting(client); }}>删除</button>
                  </>
                ) : (
                  <>
                    {status === "installed" || status === "disabled" ? null : (
                      <button type="button" className="text-button" aria-label={`${hooked ? "重新接入" : "接入"} ${client.name}`} disabled={rowBusy(client.id)} onClick={(event) => connect(client, event.currentTarget)}>
                        {hooked ? "重新接入" : "接入"}
                      </button>
                    )}
                    {hooked ? (
                      <button type="button" className="text-button danger-button" aria-label={`断开 ${client.name}`} aria-haspopup="dialog" disabled={rowBusy(client.id)} onClick={() => { setDisconnectError(null); setConfirmingDisconnect(client); }}>断开</button>
                    ) : null}
                  </>
                )}
              </span>
            </div>
            <p>{client.status.detail}</p>
            {rowMessages[`client:${client.id}`] === undefined ? null : <p className={rowMessages[`client:${client.id}`]!.error ? "error-message" : "client-row-notice"} role="status">{rowMessages[`client:${client.id}`]!.text}</p>}
            {client.notice === undefined ? null : <p className="client-row-notice">{client.notice}</p>}
            <div className="client-capabilities" role="group" aria-label="接入能力">
              <span>{client.mechanism} 自动捕获</span>
              <span className="client-capability">自动记录</span>
              {client.mcp === false ? null : <span className="client-capability">决策前核对</span>}
              <span>只读 · 不替你选择</span>
            </div>
          </div>
          {found === undefined ? null : (
            <div className="client-latest">
              {found ? (
                <>
                  <span>
                    最近一次记录 ·{" "}
                    <time dateTime={found.created}>
                      {new Date(found.created).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </time>
                  </span>
                  <p className="question-clamp">{plainHeadline(found.question)}</p>
                </>
              ) : (
                <span>
                  {client.status.healthy
                    ? "还没有记录到决策：在对话里做一次选择后会出现在这里。"
                    : "还没有记录到决策。"}
                </span>
              )}
            </div>
          )}
        </div>
      </article>
    );
  };

  const disconnectNames = confirmingDisconnect === "all" ? connected.map((client) => client.name) : confirmingDisconnect === null ? [] : [confirmingDisconnect.name];

  return (
    <section
      className="desktop-view clients-panel"
      role="region"
      aria-label="接入"
    >
      <DesktopPageHeader
        eyebrow="智能体"
        title="接入"
        description="管理各个 agent 工具的决策采集接入：已接入的在前，本机检测到的其次。"
        meta={connectedCount}
        metaLabel="项接入正常"
      />
      <SettingsSubnav active="clients" api={api} />

      <div className="desktop-page-scroll client-page-content">
        <section className="settings-card client-list-card" aria-labelledby="client-list-title">
          <header className="settings-card-header">
            <div>
              <h2 id="client-list-title">客户端</h2>
            </div>
            <span className="client-list-summary">
              已连接 {connectedCount} / {connected.length + detected.length}
              {attentionCount === 0 ? null : <em> · {attentionCount} 个需要处理</em>}
            </span>
          </header>
          {[...connected, ...detected].map(row)}
          {others.length === 0 ? null : (
            // Tools Paraself can connect that are not on this machine: out of the way until asked for.
            <details className="client-others">
              <summary>其他支持的工具（{others.length}）</summary>
              {others.map(row)}
            </details>
          )}
          {/* A tool not listed above: the assistant connects it in a conversation (its 接入新工具). */}
          <div className="client-onboarding-entry">
            <p>想接的工具不在上面？助手可以和你一起把它接进来：确认命令、临时装个探针看看它的钩子，再给出接入方案。</p>
            <button type="button" className="secondary-button" onClick={startOnboarding}>接入其他工具</button>
          </div>
        </section>

        <section
          className="settings-card client-actions-card"
          aria-labelledby="client-actions-title"
        >
          <div className="client-actions-body">
            <div>
              <h2 id="client-actions-title">接入维护</h2>
              <p>
                检查只读取配置；全部修复会为本机检测到的工具更新自动记录与只读建议入口；断开全部会把两者从已接入的工具移除，已发布的技能和工作流保留。
              </p>
            </div>
            <div className="client-page-actions">
              {/* Taking the capture out is apart from keeping it working: first, in the danger colour, past a rule. */}
              <button
                type="button"
                className="text-button danger-button client-disconnect"
                aria-haspopup="dialog"
                disabled={batchBusy || connectedIds.length === 0}
                onClick={() => { setDisconnectError(null); setConfirmingDisconnect("all"); }}
              >
                断开全部
              </button>
              <span className="client-actions-divider" aria-hidden="true" />
              <button
                type="button"
                className="secondary-button"
                disabled={pending.check || onMachine.length === 0}
                onClick={(event) =>
                  keepSwitchFocus(event.currentTarget, run(
                    () => api.installIntegrations("dry-run", onMachine),
                    checkedMessage,
                    anyFailed,
                    undefined,
                    "check",
                  ))
                }
              >
                检查连接
              </button>
              <button
                type="button"
                // Repair is the action only when something needs it; with every
                // client connected it is maintenance, not a call to act.
                className={attentionCount === 0 ? "secondary-button" : "primary-button"}
                disabled={batchBusy || onMachine.length === 0}
                onClick={(event) =>
                  keepSwitchFocus(event.currentTarget, run(
                    () => api.installIntegrations("apply", onMachine),
                    appliedMessage,
                    anyFailed,
                  ))
                }
              >
                全部修复
              </button>
            </div>
          </div>
          {/* What a check, a repair or a disconnect did, under the buttons that did it. */}
          {checkMessage === null ? null : <p className={checkMessage.error ? "settings-status error" : "settings-status"} role="status">{checkMessage.text}</p>}
          {message === null ? null : (
            <p className={message.error ? "settings-status error" : "settings-status"} role="status">
              {message.text}
            </p>
          )}
        </section>
      </div>
      {confirmingDisconnect === null ? null : (
        <ModalDialog
          title={confirmingDisconnect === "all" ? "断开所有已接入的工具？" : `断开 ${confirmingDisconnect.name}？`}
          size="compact"
          dismissible={!disconnectBusy}
          onClose={() => setConfirmingDisconnect(null)}
          footer={<>
            <button type="button" className="secondary-button" autoFocus disabled={disconnectBusy} onClick={() => setConfirmingDisconnect(null)}>取消</button>
            <button type="button" className="primary-button danger-button" disabled={disconnectBusy} onClick={() => void disconnect()}>{disconnectBusy ? "正在断开…" : "断开"}</button>
          </>}
        >
          <p>{disconnectNames.join("、")} 里的自动记录和决策前核对都会移除，之后的对话不再记到 Paraself。已发布的技能和工作流保留，客户端仍会加载它们。</p>
          <p>随时可以再点「接入」；{restart(knownClients().filter((client) => disconnectNames.includes(client.name)))}</p>
          {disconnectError === null ? null : <p className="form-error" role="alert">{disconnectError}</p>}
        </ModalDialog>
      )}
      {deleting === null ? null : (
        <ModalDialog
          title={`删除「${deleting.name}」？`}
          size="compact"
          dismissible={!deleteBusy}
          onClose={() => setDeleting(null)}
          footer={<>
            <button type="button" className="secondary-button" autoFocus disabled={deleteBusy} onClick={() => setDeleting(null)}>取消</button>
            <button type="button" className="primary-button danger-button" disabled={deleteBusy} onClick={() => void deleteClient(deleting)}>{deleteBusy ? "正在删除…" : "删除"}</button>
          </>}
        >
          {deleting.problem === undefined
            ? <p>会先断开它：移除 Paraself 写进它钩子配置文件的内容，以及注册的 MCP 服务器，再删除这个客户端的配置。已经记下的决策保留。</p>
            : <p>它没有生效，删除时不会改动它填写的钩子配置文件，只删除这个客户端的配置。已经记下的决策保留。</p>}
          {deleteError === null ? null : <p className="form-error" role="alert">{deleteError}</p>}
        </ModalDialog>
      )}
    </section>
  );
};
