import type {
  ModelBackendKind,
  ModelInvocationErrorCode,
  ModelInvocationTrace,
} from "@cognelis/decision-protocol";
import { useEffect, useState } from "react";

import type { DecisionApi } from "../../shared/renderer-api.js";
import { ModalDialog } from "./ModalDialog.js";

interface ModelTracePanelProps {
  api: DecisionApi;
  contentEnabled: boolean;
}

const providerLabel: Record<ModelBackendKind, string> = {
  apple: "Apple 本地模型",
  qwen: "Qwen 本地模型",
  openai: "OpenAI",
  anthropic: "Anthropic",
  "openai-compatible": "OpenAI 兼容 API",
  "codex-cli": "Codex",
  "claude-code-cli": "Claude Code",
};

const statusLabel: Record<ModelInvocationTrace["status"], string> = {
  succeeded: "成功",
  timed_out: "超时",
  cancelled: "已取消",
  auth_failed: "认证失败",
  unavailable: "不可用",
  invalid_output: "输出无效",
  failed: "失败",
};

const errorLabel: Record<ModelInvocationErrorCode, string> = {
  timeout: "请求超时",
  cancelled: "调用已取消",
  authentication_failed: "认证失败",
  authorization_failed: "没有访问权限",
  rate_limited: "请求过于频繁",
  provider_unavailable: "后端不可用",
  invalid_output: "返回格式无效",
  output_limit: "输出达到长度上限",
  invalid_configuration: "配置无效",
  credential_unavailable: "未配置凭据",
  credential_decryption_failed: "无法读取凭据",
  network_error: "网络连接失败",
  response_too_large: "响应内容过大",
  redirect_rejected: "重定向被拒绝",
  process_failed: "客户端进程失败",
  executable_missing: "未找到客户端",
  unsupported_client: "客户端版本不受支持",
  trace_write_failed: "调用记录写入失败",
  unknown: "未知错误",
};

const prettyJson = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "无法显示此结构化内容";
  }
};

const tokenLabel = (trace: ModelInvocationTrace): string =>
  trace.usage.totalTokens === undefined
    ? "Token 统计未提供"
    : `${trace.usage.totalTokens} tokens`;

export const ModelTracePanel = ({
  api,
  contentEnabled,
}: ModelTracePanelProps) => {
  const [traces, setTraces] = useState<ModelInvocationTrace[]>([]);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(contentEnabled);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const selectedTrace = traces.find(
    (trace) => trace.traceId === selectedTraceId,
  );

  const load = async (): Promise<void> => {
    const next = await api.listModelTraces();
    setTraces(
      [...next].sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) ||
          right.traceId.localeCompare(left.traceId),
      ),
    );
  };

  useEffect(() => {
    let active = true;
    void api
      .listModelTraces()
      .then((next) => {
        if (active) {
          setTraces(
            [...next].sort(
              (left, right) =>
                right.createdAt.localeCompare(left.createdAt) ||
                right.traceId.localeCompare(left.traceId),
            ),
          );
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setMessage(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      active = false;
    };
  }, [api]);

  const mutate = async (
    operation: () => Promise<unknown>,
    success: string,
  ): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      await operation();
      await load();
      setMessage(success);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section
        className="settings-card model-trace-card"
        aria-labelledby="model-trace-title"
        role="region"
      >
        <header className="settings-card-header model-trace-header">
          <div>
            <h2 id="model-trace-title">模型调用记录</h2>
            <span>仅保存在本机，默认 7 天后删除</span>
          </div>
          <div className="model-trace-controls">
            <label>
              <input
                type="checkbox"
                checked={enabled}
                disabled={busy}
                onChange={(event) => {
                  const next = event.currentTarget.checked;
                  setEnabled(next);
                  void mutate(
                    () => api.setModelTraceContentEnabled(next),
                    next
                      ? "新的模型调用将记录输入和输出。"
                      : "新的模型调用只记录元数据。",
                  );
                }}
              />
              记录模型输入和输出
            </label>
            <button
              type="button"
              className="text-button"
              disabled={busy || traces.length === 0}
              onClick={() => {
                if (!confirmClear) {
                  setConfirmClear(true);
                  setMessage("再次点击以确认清空全部模型调用记录。");
                  return;
                }
                setConfirmClear(false);
                void mutate(
                  () => api.clearModelTraces(),
                  "模型调用记录已清空。",
                );
              }}
            >
              {confirmClear ? "确认清空全部记录" : "清空记录"}
            </button>
          </div>
        </header>

        {traces.length === 0 ? (
          <p className="empty-copy">目前没有模型调用记录。</p>
        ) : (
          <ol
            className="model-trace-list"
            aria-label="模型调用记录列表"
            tabIndex={0}
          >
            {traces.map((trace) => {
              return (
                <li key={trace.traceId}>
                  <div className="model-trace-row">
                    <div className="model-trace-provider">
                      <strong>{providerLabel[trace.profile.backend]}</strong>
                      <span>{trace.profile.model}</span>
                    </div>
                    <time dateTime={trace.createdAt}>
                      {new Date(trace.createdAt).toLocaleString()}
                    </time>
                    <span
                      className={`model-trace-status status-${trace.status}`}
                    >
                      {statusLabel[trace.status]}
                    </span>
                    <span>{tokenLabel(trace)}</span>
                    <span>{trace.timing.totalMs} ms</span>
                    <button
                      type="button"
                      className="text-button"
                      aria-haspopup="dialog"
                      onClick={() => setSelectedTraceId(trace.traceId)}
                    >
                      查看调用详情
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        {message === null ? null : (
          <p className="model-trace-message" role="status">
            {message}
          </p>
        )}
      </section>

      {selectedTrace === undefined ? null : (
        <ModalDialog
          title={`${providerLabel[selectedTrace.profile.backend]} 调用详情`}
          description={new Date(selectedTrace.createdAt).toLocaleString()}
          dismissible={!busy}
          onClose={() => setSelectedTraceId(null)}
          size="wide"
        >
          <div className="model-trace-details model-trace-dialog-details">
            {selectedTrace.input === undefined ? (
              <p>这条记录未保存模型输入和输出。</p>
            ) : (
              <section>
                <h3>模型输入</h3>
                <pre tabIndex={0}>
                  {`${selectedTrace.input.systemPrompt}\n\n${selectedTrace.input.userPrompt}`}
                </pre>
              </section>
            )}
            {selectedTrace.output === undefined ? null : (
              <section>
                <h3>模型输出</h3>
                <pre tabIndex={0}>{selectedTrace.output.visibleText}</pre>
                <h3>结构化结果</h3>
                <pre tabIndex={0}>
                  {prettyJson(selectedTrace.output.parsed)}
                </pre>
              </section>
            )}
            <dl>
              <div>
                <dt>Token 来源</dt>
                <dd>{selectedTrace.usage.source}</dd>
              </div>
              {selectedTrace.errorCode === undefined ? null : (
                <div>
                  <dt>错误</dt>
                  <dd>{errorLabel[selectedTrace.errorCode]}</dd>
                </div>
              )}
              {selectedTrace.diagnosticExcerpt === undefined ? null : (
                <div>
                  <dt>诊断</dt>
                  <dd>{selectedTrace.diagnosticExcerpt}</dd>
                </div>
              )}
            </dl>
            <div className="model-trace-actions">
              <button
                type="button"
                className="secondary-button danger-text"
                disabled={busy}
                onClick={() =>
                  void mutate(async () => {
                    await api.deleteModelTrace(selectedTrace.traceId);
                    setSelectedTraceId(null);
                  }, "这条模型调用记录已删除。")
                }
              >
                删除这条记录
              </button>
              <button
                type="button"
                className="secondary-button danger-text"
                disabled={busy}
                onClick={() =>
                  void mutate(async () => {
                    await api.deleteModelTraceRequest(selectedTrace.requestId);
                    setSelectedTraceId(null);
                  }, "本次调用的全部记录已删除。")
                }
              >
                删除本次调用
              </button>
            </div>
          </div>
        </ModalDialog>
      )}
    </>
  );
};
