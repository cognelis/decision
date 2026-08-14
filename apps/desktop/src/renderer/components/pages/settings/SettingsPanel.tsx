import { useState } from "react";

import {
  THEME_PREFERENCES,
  type ThemePreference,
} from "../../../../shared/appearance.js";
import type {
  AppSnapshot,
  DecisionApi,
} from "../../../../shared/renderer-api.js";
import { DesktopPageHeader } from "../DesktopPageHeader.js";

interface SettingsPanelProps {
  snapshot: AppSnapshot;
  api: DecisionApi;
}

const themeLabel: Record<ThemePreference, string> = {
  auto: "自动",
  light: "浅色",
  dark: "深色",
};

export const SettingsPanel = ({ snapshot, api }: SettingsPanelProps) => {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  return (
    <section
      className="desktop-view settings-panel"
      role="region"
      aria-label="通用设置"
    >
      <DesktopPageHeader
        eyebrow="应用偏好"
        title="通用设置"
        description="只保留应用级偏好、数据位置与索引维护。"
        meta="本机"
        metaLabel="数据存储"
      />

      <div className="desktop-page-scroll general-settings-content">
        <section
          className="settings-card general-card"
          aria-labelledby="appearance-title"
        >
          <header className="settings-card-header">
            <div>
              <h2 id="appearance-title">外观</h2>
              <span>主题会立即应用到整个应用</span>
            </div>
          </header>
          <div className="general-setting-block appearance-setting-block">
            <div>
              <strong>颜色主题</strong>
              <p>跟随系统，或固定使用浅色、深色外观。</p>
            </div>
            <div className="theme-segment" role="group" aria-label="外观">
              {THEME_PREFERENCES.map((theme) => (
                <button
                  key={theme}
                  aria-pressed={snapshot.theme === theme}
                  disabled={busy}
                  onClick={() =>
                    void run(() => api.setTheme(theme), "主题已更新。")
                  }
                >
                  {themeLabel[theme]}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section
          className="settings-card general-card"
          aria-labelledby="storage-title"
        >
          <header className="settings-card-header">
            <div>
              <h2 id="storage-title">数据与索引</h2>
              <span>Markdown 是事实源，索引可以随时重建</span>
            </div>
          </header>
          <div className="general-setting-block storage-setting-block">
            <div>
              <strong>Obsidian 仓库</strong>
              <p>决策 Markdown 的保存位置</p>
            </div>
            <code className="path-value">
              {snapshot.vaultPath ?? "尚未选择仓库"}
            </code>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() =>
                void run(() => api.chooseVault(), "仓库已更新，重启后生效。")
              }
            >
              更换仓库
            </button>
          </div>
          <div className="general-setting-block index-setting-block">
            <div>
              <strong>全文索引</strong>
              <p>用于搜索和统计，可以从 Markdown 恢复</p>
            </div>
            <span className={`inline-health ${snapshot.health.index}`}>
              {snapshot.health.index === "healthy" ? "索引正常" : "需要关注"}
            </span>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() =>
                void run(
                  () => api.rebuildIndex(),
                  "SQLite 索引已从 Markdown 重建。",
                )
              }
            >
              重建索引
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
