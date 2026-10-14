import { useEffect, useState } from "react";

import type {
  AppSnapshot,
  DecisionApi,
  DecisionLibraryItem,
} from "../../../../shared/renderer-api.js";
import { DesktopPageHeader } from "../DesktopPageHeader.js";
import { SettingsSubnav } from "../SettingsSubnav.js";
import { keepSwitchFocus } from "../../../keyboard.js";

interface ClientsPanelProps {
  snapshot: AppSnapshot;
  api: DecisionApi;
}

const clientStatus = (
  status: AppSnapshot["integrationStatus"]["codex"],
): { label: string; healthy: boolean; detail: string } => {
  if (status === "installed") {
    return {
      label: "已连接",
      healthy: true,
      detail:
        "自动记录已启用；代理也能在给出选项前读取相关原则与失败边界。",
    };
  }
  if (status === "not-installed") {
    return {
      label: "未连接",
      healthy: false,
      detail: "尚未安装自动记录和决策前原则核对，可以在下方直接连接。",
    };
  }
  if (status === "upgrade-required") {
    return {
      label: "需重新连接",
      healthy: false,
      detail: "接入配置与当前的 Decision 不一致（App 被移动、升级到了新位置，或仍是旧版配置）；点「安装或修复」重新连接。",
    };
  }
  if (status === "disabled") {
    return {
      label: "hook 已关闭",
      healthy: false,
      detail: "它的设置关掉了所有 hook（disableAllHooks），自动记录不会运行；在它的 settings.json 里去掉这一项并重启后才会恢复。",
    };
  }
  return {
    label: "待检查",
    healthy: false,
    detail: "没能读出接入配置，点「检查连接」看具体原因。",
  };
};

type InstallReport = Awaited<ReturnType<DecisionApi["installIntegrations"]>>;

const CLIENT_NAMES = { "claude-code": "Claude Code", codex: "Codex" } as const;

/** What a check found: nothing is changed by it, so it says which clients would be. */
const checkedMessage = (report: InstallReport): string => {
  const stale = report.targets.filter((target) => target.changed).map((target) => CLIENT_NAMES[target.client]);
  // A file it could not read says so, and which, rather than the check failing for both clients.
  const unreadable = report.targets
    .filter((target) => target.status === "failed")
    .map((target) => `${CLIENT_NAMES[target.client]} 的配置文件没法处理（${target.detail ?? "原因未知"}）`);
  const parts = [
    ...(stale.length === 0 ? [] : [`${stale.join("、")} 还没有接入或需要更新，可以点「安装或修复」`]),
    ...unreadable,
  ];
  return parts.length === 0
    ? "检查完成，接入配置已是最新，没有修改。"
    : `检查完成，没有修改接入配置；${parts.join("；")}。`;
};

// A running client read its hooks and servers when it started: one connected or disconnected while it ran went on
// as it was, and the reader took the change for not working.
const RESTART = "重启正在运行的 Claude Code 或 Codex 后生效。";

/** What an install did for each client: one can connect while the other is skipped or fails. */
const appliedMessage = (report: InstallReport): string => {
  const parts = report.targets.flatMap((target) =>
    target.status === undefined ? [] : [
      target.status === "installed"
        ? `${CLIENT_NAMES[target.client]} 已接入${target.detail === undefined ? "" : `（${target.detail}）`}`
        : target.status === "skipped"
          ? `${target.detail ?? "没有找到命令"}，跳过了 ${CLIENT_NAMES[target.client]}`
          : `${CLIENT_NAMES[target.client]} 没有接上：${target.detail ?? "原因未知"}`,
    ]);
  return `${parts.length === 0 ? "接入已安装或修复。" : `${parts.join("；")}。`}${report.restartRequired ? RESTART : ""}`;
};

/** What a disconnect did for each client, and what it leaves there: the skills published to it. */
const removedMessage = (report: InstallReport): string => {
  const parts = report.targets.map((target) =>
    target.status === "removed"
      ? `${CLIENT_NAMES[target.client]} 已断开${target.detail === undefined ? "" : `（${target.detail}）`}`
      : target.status === "skipped"
        ? `${target.detail ?? "没有找到命令"}，跳过了 ${CLIENT_NAMES[target.client]}`
        : `${CLIENT_NAMES[target.client]} 没有断开：${target.detail ?? "原因未知"}`,
  );
  const removed = report.restartRequired && report.targets.some((target) => target.status === "removed");
  return `${parts.join("；")}。${removed ? RESTART : ""}${report.note ?? ""}`;
};

export const ClientsPanel = ({ snapshot, api }: ClientsPanelProps) => {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // What each client last brought in: "connected" says the hook is installed, this says it works.
  const [latest, setLatest] = useState<Partial<Record<"claude-code" | "codex", DecisionLibraryItem | null>>>({});
  useEffect(() => {
    let active = true;
    void Promise.all((["claude-code", "codex"] as const).map(async (source) =>
      [source, (await api.listDecisions({ query: "", sourceClient: source, limit: 1 }))[0] ?? null] as const,
    )).then(
      (found) => { if (active) setLatest(Object.fromEntries(found)); },
      () => undefined,
    );
    return () => {
      active = false;
    };
    // Read again as each decision comes in: read once, a client just connected and tested still said nothing had.
  }, [api, snapshot.dashboard.totalDecisions]);
  const connectedCount = Object.values(snapshot.integrationStatus).filter(
    (status) => status === "installed",
  ).length;

  const run = async (
    operation: () => Promise<InstallReport>,
    success: (report: InstallReport) => string,
  ): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage(success(await operation()));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const clients = [
    {
      id: "claude-code",
      name: "Claude Code",
      shortName: "CC",
      mechanism: "Hooks + MCP",
      status: clientStatus(snapshot.integrationStatus.claudeCode),
    },
    {
      id: "codex",
      name: "Codex",
      shortName: "CX",
      mechanism: "Hooks + MCP",
      status: clientStatus(snapshot.integrationStatus.codex),
    },
  ] as const;

  return (
    <section
      className="desktop-view clients-panel"
      role="region"
      aria-label="接入"
    >
      <DesktopPageHeader
        eyebrow="智能体"
        title="接入"
        description="管理 Codex、Claude Code 的决策采集接入。"
        meta={connectedCount}
        metaLabel="项接入正常"
      />
      <SettingsSubnav active="clients" api={api} />

      <div className="desktop-page-scroll client-page-content">
        <div className="client-card-grid">
          {clients.map((client) => (
            <article className="client-card" key={client.id}>
              <div className="client-card-icon" aria-hidden="true">
                {client.shortName}
              </div>
              <div className="client-card-copy">
                <span className="client-card-kicker">
                  {client.mechanism} 自动捕获
                </span>
                <h2>{client.name}</h2>
                <p>{client.status.detail}</p>
                <div className="client-capabilities" aria-label="接入能力">
                  <span>自动记录</span>
                  <span>决策前核对</span>
                  <small>只读 · 不替你选择</small>
                </div>
                {latest[client.id] === undefined ? null : (
                  <p className="client-card-latest">
                    {latest[client.id]
                      ? `最近一次记录：${new Date(latest[client.id]!.created).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} · ${latest[client.id]!.question}`
                      : client.status.healthy
                        ? "还没有记录到决策：在对话里做一次选择后会出现在这里。"
                        : "还没有记录到决策。"}
                  </p>
                )}
              </div>
              <div
                className={`client-connection-status${
                  client.status.healthy ? " healthy" : ""
                }`}
              >
                <span className="health-dot" aria-hidden="true" />
                {client.status.label}
              </div>
            </article>
          ))}
        </div>

        <section
          className="client-actions-card"
          aria-labelledby="client-actions-title"
        >
          <div>
            <h2 id="client-actions-title">接入维护</h2>
            <p>
              检查只读取配置；安装或修复会同时更新自动记录与只读建议入口；断开会把两者从客户端移除，已发布的技能和工作流保留。
            </p>
          </div>
          <div className="client-page-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={(event) =>
                keepSwitchFocus(event.currentTarget, run(
                  () => api.installIntegrations("dry-run"),
                  checkedMessage,
                ))
              }
            >
              检查连接
            </button>
            <button
              type="button"
              // Repair is the action only when something needs it; with every
              // client connected it is maintenance, not a call to act.
              className={
                clients.every((client) => client.status.healthy)
                  ? "secondary-button"
                  : "primary-button"
              }
              disabled={busy}
              onClick={(event) =>
                keepSwitchFocus(event.currentTarget, run(
                  () => api.installIntegrations("apply"),
                  appliedMessage,
                ))
              }
            >
              安装或修复
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={(event) =>
                keepSwitchFocus(event.currentTarget, run(
                  () => api.removeIntegrations(),
                  removedMessage,
                ))
              }
            >
              断开
            </button>
          </div>
        </section>


      </div>
      {message === null ? null : (
        <p className="settings-message" role="status">
          {message}
        </p>
      )}
    </section>
  );
};
