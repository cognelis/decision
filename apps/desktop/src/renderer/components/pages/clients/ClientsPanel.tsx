import { useState } from "react";

import type {
  AppSnapshot,
  DecisionApi,
} from "../../../../shared/renderer-api.js";
import { DesktopPageHeader } from "../DesktopPageHeader.js";

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
      label: "需升级",
      healthy: false,
      detail: "旧版连接仍可使用；重新连接后会无损升级到当前配置。",
    };
  }
  return {
    label: "待检查",
    healthy: false,
    detail: "还没有读取到客户端连接状态。",
  };
};

export const ClientsPanel = ({ snapshot, api }: ClientsPanelProps) => {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const connectedCount = Object.values(snapshot.integrationStatus).filter(
    (status) => status === "installed",
  ).length;

  const run = async (
    operation: () => Promise<unknown>,
    success: string,
  ): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      await operation();
      setMessage(success);
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
        eyebrow="连接"
        title="接入"
        description="管理 Codex 与 Claude Code 的决策采集接入。"
        meta={connectedCount}
        metaLabel="项接入正常"
      />

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
              检查只读取配置；安装或修复会同时更新自动记录与只读建议入口。
            </p>
          </div>
          <div className="client-page-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() =>
                void run(
                  () => api.installIntegrations("dry-run"),
                  "检查完成，没有修改接入配置。",
                )
              }
            >
              检查连接
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() =>
                void run(
                  () => api.installIntegrations("apply"),
                  "接入已安装或修复。",
                )
              }
            >
              安装或修复
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
