import { traceCost, costAmount } from "../../shared/model-pricing.js";
import { zonedFormatter } from "../calendar-date.js";
import type {
  ModelBackendKind,
  ModelInvocationErrorCode,
  ModelInvocationTrace,
  RedactedModelProviderProfile,
} from "@cognelis/decision-protocol";
import { useEffect, useState } from "react";

import type { DecisionApi } from "../../shared/renderer-api.js";
import { ModalDialog } from "./ModalDialog.js";
import { tokenSourceCopy } from "./ModelProviderPanel.js";
import { keepSwitchFocus } from "../keyboard.js";

interface ModelTracePanelProps {
  api: DecisionApi;
  contentEnabled: boolean;
  /** Moves when the counts above the list move (a call recorded meanwhile): the list is read again. */
  refreshKey?: string;
}

const CONFIRM_CLEAR = "再次点击以确认清空全部模型调用记录。";

const providerLabel: Record<ModelBackendKind, string> = {
  apple: "Apple 本地模型",
  qwen: "Qwen 本地模型",
  openai: "OpenAI",
  anthropic: "Anthropic",
  "openai-compatible": "OpenAI 兼容 API",
  "codex-cli": "Codex",
  "claude-code-cli": "Claude Code",
};

const purposeLabel: Record<string, string> = {
  "pr-review": "PR 评审",
  "semantic-classification": "语义识别",
  "provider-health-check": "连通性测试",
  "methodology-extraction": "原则提炼",
  "skill-drafting": "技能草案",
  "workflow-drafting": "工作流草案",
  "retrieval-answer": "问答",
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
  quota_exhausted: "额度或余额不足",
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

/** A remote API's failure is written as "HTTP 400: " and the body it sent; the message is in the body. */
const httpStatus = (diagnostic: string): string => /^HTTP \d{3}: /u.exec(diagnostic)?.[0] ?? "";

const readableDiagnostic = (diagnostic: string): string => {
  const body = diagnostic.slice(httpStatus(diagnostic).length);
  try {
    const data: unknown = (() => { try { return JSON.parse(body); } catch { return JSON.parse(body.split("\n")[0]!); } })();
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const root = data as Record<string, unknown>;
      const error = root.error && typeof root.error === "object" ? root.error as Record<string, unknown> : root;
      if (typeof error.message === "string") return error.message;
    }
  } catch { /* CLI diagnostics may be plain text rather than JSON. */ }
  return diagnostic;
};

const prettyDiagnostic = (diagnostic: string): string => {
  const status = httpStatus(diagnostic);
  try { return `${status}${prettyJson(JSON.parse(diagnostic.slice(status.length)))}`; } catch { return diagnostic; }
};

const compactCount = (value: number): string =>
  value < 1_000 ? `${value}` : `${(value / 1_000).toFixed(1)}k`;

type Pricing = NonNullable<RedactedModelProviderProfile["pricing"]>;

/**
 * What the listed calls add up to. Money only for calls whose backend has the
 * reader's price, and tokens as a floor when some calls reported none.
 */
const usageSummary = (
  traces: ModelInvocationTrace[],
  prices: ReadonlyMap<string, Pricing>,
): string => {
  const failed = traces.filter((trace) => trace.status !== "succeeded").length;
  const reported = traces.filter(
    (trace) => trace.usage.totalTokens !== undefined,
  );
  const tokens = reported.reduce(
    (sum, trace) => sum + (trace.usage.totalTokens ?? 0),
    0,
  );
  const spend = new Map<string, { minimum: number; maximum: number }>();
  let unpriced = 0;
  for (const trace of traces) {
    const price = trace.profile.pricing ?? prices.get(trace.profile.profileId);
    const estimate = traceCost(trace, price);
    if (price === undefined || estimate === null) { unpriced += 1; continue; }
    const previous = spend.get(price.currency) ?? { minimum: 0, maximum: 0 };
    spend.set(price.currency, { minimum: previous.minimum + estimate.minimum, maximum: previous.maximum + estimate.maximum });
  }
  const money = [...spend]
    .map(
      ([currency, amount]) =>
        `${currency}${costAmount(amount.minimum, amount.maximum)}`,
    )
    .join(" + ");
  const seconds =
    traces.reduce((sum, trace) => sum + trace.timing.totalMs, 0) /
    traces.length /
    1_000;
  return [
    `${traces.length} 次调用`,
    failed > 0 ? `未成功 ${failed}` : "",
    reported.length === 0
      ? ""
      : `${reported.length < traces.length ? "至少 " : ""}${compactCount(tokens)} tokens`,
    `平均 ${seconds.toFixed(1)} 秒`,
    money === ""
      ? ""
      : `≈ ${money}${unpriced > 0 ? `（${unpriced} 次未计价）` : ""}`,
  ]
    .filter(Boolean)
    .join(" · ");
};


// The rest of the app writes dates in Chinese; a bare toLocaleString follows
// the system locale instead and put "7/31/2026, 6:30:00 PM" in this list.
const traceTimeFormatter = zonedFormatter({
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export const ModelTracePanel = ({
  api,
  contentEnabled,
  refreshKey,
}: ModelTracePanelProps) => {
  const [traces, setTraces] = useState<ModelInvocationTrace[]>([]);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  // One assistant turn writes up to eight rows, so without a filter the log is
  // whatever was asked most recently and nothing else.
  const [purpose, setPurpose] = useState<string>("all");
  const [failedOnly, setFailedOnly] = useState(false);
  const [enabled, setEnabled] = useState(contentEnabled);
  const [busy, setBusy] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  useEffect(() => setCopyNotice(null), [selectedTraceId]);
  const [prices, setPrices] = useState<ReadonlyMap<string, Pricing>>(
    new Map(),
  );
  const selectedTrace = traces.find(
    (trace) => trace.traceId === selectedTraceId,
  );
  const related = selectedTrace === undefined ? [] : traces.filter(trace => trace.requestId === selectedTrace.requestId).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.traceId.localeCompare(b.traceId));
  const purposes = [...new Set(traces.map((trace) => trace.purpose))].sort();
  // Once the last record of the kind chosen is deleted, the list goes back to all of them rather than
  // standing empty with the filter gone from the page.
  const shownPurpose = purpose === "all" || purposes.some((kind) => kind === purpose) ? purpose : "all";
  const byPurpose =
    shownPurpose === "all"
      ? traces
      : traces.filter((trace) => trace.purpose === shownPurpose);
  // A failure is the usual reason to open this list; once none is left, the switch has nothing to narrow to.
  const failures = byPurpose.filter((trace) => trace.status !== "succeeded");
  const visible = failedOnly && failures.length > 0 ? failures : byPurpose;

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
    // Read once, a call that failed while the page was open was counted above and missing below.
  }, [api, refreshKey]);

  useEffect(() => {
    let active = true;
    void api
      .listModelProviderProfiles()
      .then((profiles) => {
        if (active) {
          setPrices(
            new Map(
              profiles.flatMap((profile) =>
                profile.pricing === undefined
                  ? []
                  : [[profile.profileId, profile.pricing] as const],
              ),
            ),
          );
        }
      })
      // Without prices the summary stays in tokens.
      .catch(() => undefined);
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
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setBusy(false);
      return;
    }
    try {
      await load();
      setMessage(success);
    } catch (error) {
      // Done, only the list not read again: said as the failure alone, the deletion looked as if it had not happened.
      setMessage(`${success}列表暂时无法刷新：${error instanceof Error ? error.message : String(error)}`);
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
              记录模型输入和输出
              <input
                type="checkbox"
                role="switch"
                checked={enabled}
                disabled={busy}
                onChange={(event) => {
                  const next = event.currentTarget.checked;
                  keepSwitchFocus(event.currentTarget, mutate(
                    async () => {
                      await api.setModelTraceContentEnabled(next);
                      setEnabled(next);
                    },
                    next
                      ? "新的模型调用将记录输入和输出。"
                      : "新的模型调用只记录元数据。",
                  ));
                }}
              />
            </label>
            <button
              type="button"
              className="text-button"
              disabled={busy || traces.length === 0}
              // Armed until the reader goes elsewhere: kept, one stray click on it after other actions wiped every record.
              onBlur={() => {
                if (!confirmClear) return;
                setConfirmClear(false);
                setMessage((current) => (current === CONFIRM_CLEAR ? null : current));
              }}
              onClick={(event) => {
                if (!confirmClear) {
                  setConfirmClear(true);
                  setMessage(CONFIRM_CLEAR);
                  return;
                }
                // The second click of a double-click lands on the confirmation the first just put there:
                // only a click of its own confirms.
                if (event.detail > 1) return;
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

        {visible.length === 0 ? null : (
          <div className="model-trace-toolbar">
            {purposes.length < 2 ? null : (
              <select
                className="model-trace-filter"
                value={shownPurpose}
                aria-label="按用途筛选"
                onChange={(event) => setPurpose(event.target.value)}
              >
                <option value="all">全部（{traces.length}）</option>
                {purposes.map((value) => (
                  <option key={value} value={value}>
                    {purposeLabel[value] ?? value}（
                    {traces.filter((trace) => trace.purpose === value).length}）
                  </option>
                ))}
              </select>
            )}
            {failures.length === 0 ? null : (
              <label className="model-trace-failed-only">
                <input
                  type="checkbox"
                  checked={failedOnly}
                  onChange={(event) => setFailedOnly(event.currentTarget.checked)}
                />
                只看未成功（{failures.length}）
              </label>
            )}
            <p className="model-trace-summary">
              {usageSummary(visible, prices)}
            </p>
          </div>
        )}

        {visible.length === 0 ? (
          <p className="empty-copy">
            {traces.length === 0
              ? "目前没有模型调用记录。"
              : "这一类下没有记录。"}
          </p>
        ) : (
          <ol
            className="model-trace-list"
            aria-label="模型调用记录列表"
            tabIndex={0}
          >
            {visible.map((trace) => {
              return (
                <li key={trace.traceId}>
                  <div className="model-trace-row">
                    <div className="model-trace-provider">
                      <strong>{providerLabel[trace.profile.backend]}</strong>
                      {/* Which feature made the call, when the list shows them all. */}
                      <span>{purposeLabel[trace.purpose] ?? trace.purpose} · {trace.profile.model}</span>
                    </div>
                    <time dateTime={trace.createdAt}>
                      {traceTimeFormatter.format(new Date(trace.createdAt))}
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
                      详情
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
          description={traceTimeFormatter.format(new Date(selectedTrace.createdAt))}
          dismissible={!busy}
          onClose={() => setSelectedTraceId(null)}
          size="wide"
        >
          <div className="model-trace-details model-trace-dialog-details">
            {selectedTrace.status === "succeeded" ? null : <section className="model-trace-error-summary" aria-label="失败原因">
              <h3><span>{errorLabel[selectedTrace.errorCode ?? "unknown"]}</span> · <code>{selectedTrace.errorCode ?? selectedTrace.status}</code></h3>
              {selectedTrace.diagnosticExcerpt ? <p>{readableDiagnostic(selectedTrace.diagnosticExcerpt)}</p> : <p>这条记录没有更具体的后端诊断。</p>}
              {/invalid_json_schema|Invalid schema for response_format/u.test(selectedTrace.diagnosticExcerpt ?? "") ? <p>服务端拒绝了输出 Schema，请检查结构化输出格式的兼容性；重复同一请求通常无法解决。</p> : null}
              {selectedTrace.diagnosticExcerpt ? <details><summary tabIndex={0}>原始诊断（已脱敏）</summary><pre tabIndex={0}>{prettyDiagnostic(selectedTrace.diagnosticExcerpt)}</pre></details> : null}
            </section>}
            <section>
              <h3>调用信息</h3>
              <dl>
                <div><dt>状态</dt><dd>{statusLabel[selectedTrace.status]} · {selectedTrace.status}</dd></div>
                <div><dt>用途</dt><dd>{purposeLabel[selectedTrace.purpose] ?? selectedTrace.purpose} · {selectedTrace.purpose}</dd></div>
                <div><dt>模型配置</dt><dd>{selectedTrace.profile.provider} · {selectedTrace.profile.profileId}</dd></div>
                <div><dt>后端 / 模型</dt><dd>{selectedTrace.profile.backend} / {selectedTrace.profile.model}</dd></div>
                {selectedTrace.profile.providerVersion ? <div><dt>后端版本</dt><dd>{selectedTrace.profile.providerVersion}</dd></div> : null}
                <div><dt>Prompt 版本</dt><dd>{selectedTrace.profile.promptVersion}</dd></div>
                <div><dt>Schema 版本</dt><dd>{selectedTrace.profile.schemaVersion}</dd></div>
                <div><dt>后端尝试序号</dt><dd>{selectedTrace.attemptIndex}</dd></div>
                <div><dt>总耗时</dt><dd>{selectedTrace.timing.totalMs} ms</dd></div>
                <div><dt>执行耗时</dt><dd>{selectedTrace.timing.providerMs} ms</dd></div>
                <div><dt>已记录排队耗时</dt><dd>{selectedTrace.timing.queuedMs} ms</dd></div>
                {selectedTrace.timing.firstOutputMs === undefined ? null : <div><dt>首个输出</dt><dd>{selectedTrace.timing.firstOutputMs} ms</dd></div>}
                <div><dt>Token 来源</dt><dd>{tokenSourceCopy[selectedTrace.usage.source]}</dd></div>
                <div><dt>输入 / 输出</dt><dd>{selectedTrace.usage.inputTokens ?? "未提供"} / {selectedTrace.usage.outputTokens ?? "未提供"} tokens</dd></div>
                <div><dt>缓存 / 推理</dt><dd>{selectedTrace.usage.cachedInputTokens ?? "未提供"} / {selectedTrace.usage.reasoningOutputTokens ?? "未提供"} tokens</dd></div>
                <div><dt>总 Token</dt><dd>{selectedTrace.usage.totalTokens ?? "未提供"}</dd></div>
                {(() => {
                  const price = selectedTrace.profile.pricing ?? prices.get(selectedTrace.profile.profileId);
                  const estimate = traceCost(selectedTrace, price);
                  if (!price || !estimate) return null;
                  const period = { fixed: "固定单价", "off-peak": "空闲时段", peak: "高峰时段", "unknown-calendar": "节假日日历未覆盖" }[estimate.period];
                  return <div><dt>费用估算</dt><dd>{price.currency}{costAmount(estimate.minimum, estimate.maximum)} · {period}{estimate.cacheKnown ? "" : " · 缓存用量未知"}{selectedTrace.profile.pricing ? " · 调用时价格" : " · 按当前价格"}</dd></div>;
                })()}
                {selectedTrace.usage.costUsd === undefined ? null : <div><dt>已报告费用</dt><dd>USD {selectedTrace.usage.costUsd}</dd></div>}
                {selectedTrace.processExitCode === undefined ? null : <div><dt>进程退出码</dt><dd>{selectedTrace.processExitCode}</dd></div>}
                {selectedTrace.providerRequestId === undefined ? null : <div><dt>服务商请求 ID</dt><dd>{selectedTrace.providerRequestId}</dd></div>}
                <div><dt>请求 ID</dt><dd>{selectedTrace.requestId}</dd></div>
                <div><dt>尝试 ID</dt><dd>{selectedTrace.attemptId}</dd></div>
                <div><dt>记录 ID</dt><dd>{selectedTrace.traceId}</dd></div>
                <div><dt>记录到期</dt><dd>{traceTimeFormatter.format(new Date(selectedTrace.expiresAt))}</dd></div>
              </dl>
            </section>
            {selectedTrace.request ? <section>
              <h3>请求参数（应用侧配置）</h3>
              <dl>
                {selectedTrace.request.clientExecutable ? <div><dt>客户端路径</dt><dd>{selectedTrace.request.clientExecutable}</dd></div> : null}
                <div><dt>配置超时</dt><dd>{selectedTrace.request.configuredTimeoutMs} ms</dd></div>
                <div><dt>生成超时基准</dt><dd>{selectedTrace.request.generationTimeoutMs} ms</dd></div>
                <div><dt>请求输出上限</dt><dd>{selectedTrace.request.requestedMaxOutputTokens} tokens</dd></div>
                <div><dt>提示词长度</dt><dd>系统 {selectedTrace.request.systemPromptChars} / 用户 {selectedTrace.request.userPromptChars} 字符</dd></div>
              </dl>
            </section> : <p>这条记录未保存请求参数。</p>}
            {related.length > 1 ? <section>
              <h3>同一请求的调用链 · 当前保留 {related.length} 条</h3>
              <p className="model-trace-chain-summary">{usageSummary(related, prices)}</p>
              <details><summary tabIndex={0}>展开相关记录（按记录时间排列）</summary>
              <ol className="model-trace-chain">
                {related.map((trace, index) => <li key={trace.traceId}><button type="button" aria-current={trace.traceId === selectedTrace.traceId ? "true" : undefined}
                  onClick={() => setSelectedTraceId(trace.traceId)}>{index + 1}. {traceTimeFormatter.format(new Date(trace.createdAt))} · {trace.profile.provider} · {trace.profile.promptVersion} · {statusLabel[trace.status]} · {trace.errorCode ?? ""} · {trace.timing.totalMs} ms</button></li>)}
              </ol></details>
            </section> : null}
            {selectedTrace.input === undefined ? <p>这条记录未保存模型输入和输出。</p> : <section>
              <h3>模型输入</h3>
              {selectedTrace.input.clientSystemPromptVisibility === "opaque" ? <p>这里只记录应用发给客户端的内容；客户端自己的系统提示不可见。</p> : null}
              <details><summary tabIndex={0}>系统提示词 · {selectedTrace.input.systemPrompt.length} 字符</summary><pre tabIndex={0}>{selectedTrace.input.systemPrompt}</pre></details>
              <details><summary tabIndex={0}>用户提示词 · {selectedTrace.input.userPrompt.length} 字符</summary><pre tabIndex={0}>{selectedTrace.input.userPrompt}</pre></details>
              <details><summary tabIndex={0}>输出 Schema</summary><pre tabIndex={0}>{prettyJson(selectedTrace.input.outputSchema)}</pre></details>
            </section>}
            {selectedTrace.output === undefined ? null : <section>
              <h3>模型输出</h3>
              <pre tabIndex={0}>{selectedTrace.output.visibleText}</pre>
              <details><summary tabIndex={0}>结构化结果</summary><pre tabIndex={0}>{prettyJson(selectedTrace.output.parsed)}</pre></details>
            </section>}
            {copyNotice ? <p role="status">{copyNotice}</p> : null}
            <div className="model-trace-actions">
              <button type="button" className="secondary-button" disabled={busy} onClick={() => void (async () => {
                const { input: _input, output: _output, ...metadata } = selectedTrace;
                try { await navigator.clipboard.writeText(prettyJson(metadata)); setCopyNotice("排障信息已复制，不含模型输入或输出正文。"); }
                catch { setCopyNotice("复制失败，请重试。"); }
              })()}>复制排障信息</button>
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
