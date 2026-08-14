import type {
  LocalModelClientStatus,
  ModelApiProtocol,
  ModelInvocationErrorCode,
  ModelProviderKind,
  RedactedModelProviderProfile,
  SemanticRecognitionStatus,
} from "@cognelis/decision-protocol";
import {
  type DragEvent,
  type KeyboardEvent,
  useEffect,
  useState,
} from "react";

import type {
  DecisionApi,
  ModelProviderTestResult,
} from "../../shared/renderer-api.js";
import { ModalDialog } from "./ModalDialog.js";

interface ModelProviderPanelProps {
  api: DecisionApi;
}

type RemoteKind = "openai" | "anthropic" | "openai-compatible";

interface EditorState {
  existing: RedactedModelProviderProfile | null;
  kind: RemoteKind;
  label: string;
  model: string;
  baseUrl: string;
  apiProtocol: "responses" | "chat-completions";
  timeoutMs: string;
  secret: string;
}

interface CliEditorState {
  profile: RedactedModelProviderProfile;
  executablePath: string;
  model: string;
  timeoutMs: string;
}

interface ProviderDropTarget {
  profileId: string;
  edge: "before" | "after";
}

const kindLabel: Record<ModelProviderKind, string> = {
  apple: "Apple 本地",
  qwen: "Qwen 本地",
  openai: "OpenAI Responses",
  anthropic: "Anthropic Messages",
  "openai-compatible": "OpenAI 兼容",
  "codex-cli": "Codex 本地客户端",
  "claude-code-cli": "Claude Code 本地客户端",
};

const remoteKinds = new Set<ModelProviderKind>([
  "openai",
  "anthropic",
  "openai-compatible",
]);

const remoteCallingKinds = new Set<ModelProviderKind>([
  "openai",
  "anthropic",
  "openai-compatible",
  "codex-cli",
  "claude-code-cli",
]);

const clientStatusCopy = (status: LocalModelClientStatus): string => {
  if (status.availability === "available") {
    return "已登录，可用";
  }
  if (status.availability === "not_found") {
    return "未检测到客户端";
  }
  if (status.availability === "not_executable") {
    return "客户端路径不可执行";
  }
  if (status.availability === "logged_out") {
    return "尚未登录";
  }
  if (status.availability === "unsupported") {
    return "当前版本缺少安全调用能力";
  }
  return "客户端检查失败";
};

const defaultsFor = (
  kind: RemoteKind,
): Pick<EditorState, "label" | "baseUrl" | "apiProtocol"> => {
  if (kind === "openai") {
    return {
      label: "OpenAI",
      baseUrl: "https://api.openai.com",
      apiProtocol: "responses",
    };
  }
  if (kind === "anthropic") {
    return {
      label: "Anthropic",
      baseUrl: "https://api.anthropic.com",
      apiProtocol: "responses",
    };
  }
  return {
    label: "兼容模型服务",
    baseUrl: "http://127.0.0.1:11434",
    apiProtocol: "responses",
  };
};

const newEditor = (): EditorState => ({
  existing: null,
  kind: "openai",
  ...defaultsFor("openai"),
  model: "",
  timeoutMs: "30000",
  secret: "",
});

const editorFor = (profile: RedactedModelProviderProfile): EditorState => ({
  existing: profile,
  kind: profile.kind as RemoteKind,
  label: profile.label,
  model: profile.model ?? "",
  baseUrl: profile.baseUrl ?? "",
  apiProtocol:
    profile.apiProtocol === "chat-completions"
      ? "chat-completions"
      : "responses",
  timeoutMs: String(profile.timeoutMs),
  secret: "",
});

const secureEndpoint = (value: string): boolean => {
  try {
    const url = new URL(value);
    if (url.username.length > 0 || url.password.length > 0) {
      return false;
    }
    if (url.protocol === "https:") {
      return true;
    }
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "::1" ||
        url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
};

const nextProfileId = (): string => {
  const id =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `remote-${id}`;
};

const errorCodeCopy: Record<ModelInvocationErrorCode, string> = {
  timeout: "请求超时",
  cancelled: "测试已取消",
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

const availabilityCopy: Record<
  SemanticRecognitionStatus["availability"],
  string
> = {
  available: "可用",
  loading: "正在加载",
  device_not_eligible: "设备不支持",
  apple_intelligence_disabled: "Apple Intelligence 未启用",
  assets_unavailable: "模型资源不可用",
  model_missing: "本地模型未安装",
  checksum_failed: "模型文件校验失败",
  runtime_unavailable: "运行时不可用",
  helper_missing: "本地助手缺失",
  unavailable: "后端不可用",
};

const tokenSourceCopy: Record<
  NonNullable<ModelProviderTestResult["tokenSource"]>,
  string
> = {
  provider_reported: "服务商 Token 统计",
  runtime_measured: "本地 Token 计数",
  estimated: "Token 估算",
  unavailable: "Token 统计未提供",
};

const resultCopy = (result: ModelProviderTestResult): string => {
  if (!result.ok) {
    const reason =
      result.availability === undefined
        ? errorCodeCopy[result.errorCode ?? "unknown"]
        : availabilityCopy[result.availability];
    return `测试失败 · ${reason} · ${result.latencyMs} ms`;
  }
  return [
    "测试通过",
    `${result.latencyMs} ms`,
    result.modelVersion,
    result.tokenSource === undefined
      ? undefined
      : tokenSourceCopy[result.tokenSource],
  ]
    .filter((value) => value !== undefined)
    .join(" · ");
};

export const ModelProviderPanel = ({ api }: ModelProviderPanelProps) => {
  const [profiles, setProfiles] = useState<
    RedactedModelProviderProfile[] | null
  >(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [cliEditor, setCliEditor] = useState<CliEditorState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<
    Record<string, ModelProviderTestResult>
  >({});
  const [clientStatuses, setClientStatuses] = useState<
    LocalModelClientStatus[] | null
  >(null);
  const [draggedProfileId, setDraggedProfileId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<ProviderDropTarget | null>(null);

  const profileValues = profiles ?? [];
  const addingRemote = editor?.existing === null;

  const load = async (): Promise<void> => {
    const [profileValues, statusValues] = await Promise.all([
      api.listModelProviderProfiles(),
      api.listLocalModelClientStatuses(),
    ]);
    setProfiles(profileValues);
    setClientStatuses(statusValues);
  };

  useEffect(() => {
    let active = true;
    void api.listModelProviderProfiles().then((values) => {
      if (active) {
        setProfiles(values);
      }
    });
    void api.listLocalModelClientStatuses().then((values) => {
      if (active) {
        setClientStatuses(values);
      }
    });
    return () => {
      active = false;
    };
  }, [api]);

  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await operation();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const saveEditor = async (): Promise<void> => {
    if (editor === null) {
      return;
    }
    if (editor.label.trim().length === 0) {
      setError("请输入后端名称。");
      return;
    }
    if (editor.model.trim().length === 0) {
      setError("请输入模型名称。");
      return;
    }
    if (!secureEndpoint(editor.baseUrl)) {
      setError("服务地址必须使用 HTTPS 或本机回环地址。");
      return;
    }
    const timeoutMs = Number(editor.timeoutMs);
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1_000 ||
      timeoutMs > 120_000
    ) {
      setError("超时时间必须在 1000 到 120000 毫秒之间。");
      return;
    }
    if (editor.existing === null && editor.secret.trim().length === 0) {
      setError("请输入 API 密钥。");
      return;
    }
    const defaults = defaultsFor(editor.kind);
    const profileId = editor.existing?.profileId ?? nextProfileId();
    const priority =
      editor.existing?.priority ??
      (profileValues.length === 0
        ? 0
        : Math.max(...profileValues.map((profile) => profile.priority)) + 10);
    const apiProtocol: ModelApiProtocol =
      editor.kind === "anthropic"
        ? "messages"
        : editor.kind === "openai"
          ? "responses"
          : editor.apiProtocol;
    const profile: RedactedModelProviderProfile = {
      version: 1,
      profileId,
      kind: editor.kind,
      label: editor.label.trim() || defaults.label,
      enabled: editor.existing?.enabled ?? true,
      priority,
      model: editor.model.trim(),
      timeoutMs,
      baseUrl: editor.baseUrl.trim(),
      apiProtocol,
      credentialConfigured: editor.existing?.credentialConfigured ?? false,
    };
    await run(async () => {
      await api.saveModelProviderProfile({
        profile,
        ...(editor.secret.length === 0 ? {} : { secret: editor.secret }),
      });
      setEditor(null);
      setMessage("模型后端已保存。");
      await load();
    });
  };

  const reorder = (
    sourceProfileId: string,
    targetProfileId: string,
    edge: ProviderDropTarget["edge"],
  ): void => {
    if (sourceProfileId === targetProfileId) {
      return;
    }
    const currentOrder = profileValues.map((profile) => profile.profileId);
    const order = currentOrder.filter(
      (profileId) => profileId !== sourceProfileId,
    );
    const targetIndex = order.indexOf(targetProfileId);
    if (targetIndex < 0) {
      return;
    }
    order.splice(targetIndex + (edge === "after" ? 1 : 0), 0, sourceProfileId);
    if (order.every((profileId, index) => profileId === currentOrder[index])) {
      return;
    }
    void run(async () => {
      await api.reorderModelProviderProfiles(order);
      await load();
    });
  };

  const moveWithKeyboard = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
      return;
    }
    event.preventDefault();
    const offset = event.key === "ArrowUp" ? -1 : 1;
    const target = profileValues[index + offset];
    const source = profileValues[index];
    if (source === undefined || target === undefined) {
      return;
    }
    reorder(
      source.profileId,
      target.profileId,
      offset === -1 ? "before" : "after",
    );
  };

  const dragOver = (
    event: DragEvent<HTMLLIElement>,
    profileId: string,
  ): void => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const bounds = event.currentTarget.getBoundingClientRect();
    setDropTarget({
      profileId,
      edge: event.clientY < bounds.top + bounds.height / 2 ? "before" : "after",
    });
  };

  const drop = (
    event: DragEvent<HTMLLIElement>,
    targetProfileId: string,
  ): void => {
    event.preventDefault();
    const sourceProfileId =
      event.dataTransfer.getData("text/plain") || draggedProfileId;
    const bounds = event.currentTarget.getBoundingClientRect();
    const edge =
      event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
    setDraggedProfileId(null);
    setDropTarget(null);
    if (sourceProfileId !== null) {
      reorder(sourceProfileId, targetProfileId, edge);
    }
  };

  const saveCliEditor = async (): Promise<void> => {
    if (cliEditor === null) {
      return;
    }
    const absolutePath =
      cliEditor.executablePath.startsWith("/") ||
      /^[A-Za-z]:[\\/]/u.test(cliEditor.executablePath);
    if (!absolutePath) {
      setError("客户端路径必须是绝对路径。");
      return;
    }
    const timeoutMs = Number(cliEditor.timeoutMs);
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1_000 ||
      timeoutMs > 120_000
    ) {
      setError("超时时间必须在 1000 到 120000 毫秒之间。");
      return;
    }
    const { model: _existingModel, ...withoutModel } = cliEditor.profile;
    await run(async () => {
      await api.saveModelProviderProfile({
        profile: {
          ...withoutModel,
          executablePath: cliEditor.executablePath,
          timeoutMs,
          ...(cliEditor.model.trim().length === 0
            ? {}
            : { model: cliEditor.model.trim() }),
        },
      });
      setCliEditor(null);
      setMessage("本地客户端配置已保存。");
      await load();
    });
  };

  return (
    <section
      className="settings-card model-provider-card"
      aria-labelledby="model-provider-title"
      role="region"
    >
      <header className="settings-card-header model-provider-header">
        <div>
          <h2 id="model-provider-title">模型后端</h2>
          <span>按顺序尝试，失败时自动使用下一项</span>
        </div>
        <button
          type="button"
          className="secondary-button model-provider-add-button"
          aria-haspopup="dialog"
          aria-expanded={addingRemote}
          disabled={
            busy || cliEditor !== null || (editor !== null && !addingRemote)
          }
          onClick={() => {
            setEditor(newEditor());
            setError(null);
            setMessage(null);
          }}
        >
          添加模型后端
        </button>
      </header>

      {profiles === null ? (
        <div
          className="model-provider-list model-provider-loading"
          aria-live="polite"
        >
          <p className="empty-copy">正在读取模型后端…</p>
        </div>
      ) : profiles.length === 0 ? (
        <div className="model-provider-list model-provider-loading">
          <p className="empty-copy">尚未配置模型后端。</p>
        </div>
      ) : (
        <ol className="model-provider-list">
          {profiles.map((profile, index) => {
            const remote = remoteKinds.has(profile.kind);
            const localClient =
              profile.kind === "codex-cli" ||
              profile.kind === "claude-code-cli";
            const sendsRemote = remoteCallingKinds.has(profile.kind);
            const clientStatus = clientStatuses?.find(
              (status) => status.kind === profile.kind,
            );
            const deleting = deleteTarget === profile.profileId;
            const testResult = testResults[profile.profileId];
            const statusLabel = localClient
              ? clientStatuses === null
                ? "正在检查客户端…"
                : clientStatus === undefined
                  ? "未返回客户端状态"
                  : clientStatusCopy(clientStatus)
              : remote
                ? profile.credentialConfigured
                  ? "凭据已配置"
                  : "尚未配置凭据"
                : "内置后端";
            const statusHealthy = localClient
              ? clientStatus?.availability === "available"
              : remote
                ? profile.credentialConfigured
                : true;
            const statusDetail = localClient
              ? clientStatus?.version === undefined
                ? "本地客户端"
                : `v${clientStatus.version}`
              : sendsRemote
                ? "远程调用"
                : "本机运行";
            const dropClass =
              dropTarget?.profileId !== profile.profileId
                ? ""
                : dropTarget.edge === "before"
                  ? " drop-before"
                  : " drop-after";
            return (
              <li
                key={profile.profileId}
                className={`provider-item${
                  draggedProfileId === profile.profileId ? " dragging" : ""
                }${dropClass}`}
                onDragOver={(event) => dragOver(event, profile.profileId)}
                onDrop={(event) => drop(event, profile.profileId)}
              >
                <div className="provider-row">
                  <button
                    type="button"
                    className="provider-drag-handle"
                    draggable={!busy}
                    disabled={busy}
                    aria-label={`拖拽排序 ${profile.label}，可用上下方向键调整`}
                    title="拖拽排序"
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", profile.profileId);
                      setDraggedProfileId(profile.profileId);
                    }}
                    onDragEnd={() => {
                      setDraggedProfileId(null);
                      setDropTarget(null);
                    }}
                    onKeyDown={(event) => moveWithKeyboard(event, index)}
                  >
                    <svg viewBox="0 0 16 20" aria-hidden="true">
                      <circle cx="5" cy="5" r="1.25" />
                      <circle cx="11" cy="5" r="1.25" />
                      <circle cx="5" cy="10" r="1.25" />
                      <circle cx="11" cy="10" r="1.25" />
                      <circle cx="5" cy="15" r="1.25" />
                      <circle cx="11" cy="15" r="1.25" />
                    </svg>
                  </button>
                  <div className="provider-copy">
                    <strong>{profile.label}</strong>
                    <span>
                      {kindLabel[profile.kind]}
                      {profile.model === undefined ? "" : ` · ${profile.model}`}
                    </span>
                  </div>
                  <div className="provider-status-cell">
                    <span
                      className={
                        statusHealthy
                          ? "provider-status-healthy"
                          : "provider-status-attention"
                      }
                    >
                      {statusLabel}
                    </span>
                    <small>{statusDetail}</small>
                  </div>
                  <label className="provider-switch" title={`${profile.label} 启停`}>
                    <input
                      type="checkbox"
                      role="switch"
                      checked={profile.enabled}
                      disabled={busy}
                      aria-label={`启用 ${profile.label}`}
                      onChange={(event) => {
                        const enabled = event.currentTarget.checked;
                        void run(async () => {
                          await api.saveModelProviderProfile({
                            profile: {
                              ...profile,
                              enabled,
                              ...(clientStatus?.executablePath === undefined
                                ? {}
                                : {
                                    executablePath: clientStatus.executablePath,
                                  }),
                            },
                          });
                          await load();
                        });
                      }}
                    />
                  </label>
                  <div className="provider-actions">
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy}
                      aria-label={`测试 ${profile.label}`}
                      onClick={() =>
                        void run(async () => {
                          const result = await api.testModelProviderProfile(
                            profile.profileId,
                          );
                          setTestResults((current) => ({
                            ...current,
                            [profile.profileId]: result,
                          }));
                        })
                      }
                    >
                      测试
                    </button>
                    {localClient ? (
                      <button
                        type="button"
                        className="text-button"
                        aria-haspopup="dialog"
                        disabled={busy || editor !== null || cliEditor !== null}
                        aria-label={`配置 ${profile.label}`}
                        onClick={() => {
                          setCliEditor({
                            profile,
                            executablePath:
                              clientStatus?.executablePath ??
                              profile.executablePath ??
                              "",
                            model: profile.model ?? "",
                            timeoutMs: String(profile.timeoutMs),
                          });
                          setError(null);
                          setMessage(null);
                        }}
                      >
                        配置
                      </button>
                    ) : null}
                    {remote ? (
                      <>
                        <button
                          type="button"
                          className="text-button"
                          aria-haspopup="dialog"
                          disabled={busy || editor !== null}
                          aria-label={`编辑 ${profile.label}`}
                          onClick={() => {
                            setEditor(editorFor(profile));
                            setError(null);
                            setMessage(null);
                          }}
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          className="text-button danger-text"
                          disabled={busy}
                          aria-label={
                            deleting
                              ? `确认删除 ${profile.label}`
                              : `删除 ${profile.label}`
                          }
                          onClick={() => {
                            if (!deleting) {
                              setDeleteTarget(profile.profileId);
                              return;
                            }
                            void run(async () => {
                              await api.deleteModelProviderProfile(
                                profile.profileId,
                              );
                              setDeleteTarget(null);
                              await load();
                            });
                          }}
                        >
                          {deleting ? "确认删除" : "删除"}
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>
                {testResult === undefined ? null : (
                  <div
                    className={`provider-test-result ${
                      testResult.ok
                        ? "provider-test-ok"
                        : "provider-test-failed"
                    }`}
                    role="status"
                    aria-label={`${profile.label} 测试${
                      testResult.ok ? "通过" : "失败"
                    }`}
                  >
                    <span className="provider-test-summary">
                      {resultCopy(testResult)}
                    </span>
                    {testResult.ok ||
                    testResult.diagnosticExcerpt === undefined ? null : (
                      <span className="provider-test-detail">
                        {testResult.diagnosticExcerpt}
                      </span>
                    )}
                    {testResult.ok ||
                    (testResult.processExitCode === undefined &&
                      testResult.providerRequestId === undefined) ? null : (
                      <span className="provider-test-meta">
                        {[
                          testResult.processExitCode === undefined
                            ? undefined
                            : `退出码：${testResult.processExitCode}`,
                          testResult.providerRequestId === undefined
                            ? undefined
                            : `请求 ID：${testResult.providerRequestId}`,
                        ]
                          .filter(
                            (value): value is string => value !== undefined,
                          )
                          .join(" · ")}
                      </span>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {cliEditor === null ? null : (
        <ModalDialog
          title={`配置 ${cliEditor.profile.label}`}
          description="使用客户端现有登录状态"
          dismissible={!busy}
          onClose={() => {
            setCliEditor(null);
            setError(null);
          }}
        >
          <form
            className="model-provider-dialog-form"
            id="model-provider-cli-editor"
            aria-label={`配置 ${cliEditor.profile.label}`}
            onSubmit={(event) => {
              event.preventDefault();
              void saveCliEditor();
            }}
          >
            <div className="provider-form-grid">
              <label className="provider-url-field">
                客户端路径
                <input
                  aria-label="客户端路径"
                  autoFocus
                  value={cliEditor.executablePath}
                  onChange={(event) =>
                    setCliEditor({
                      ...cliEditor,
                      executablePath: event.currentTarget.value,
                    })
                  }
                />
              </label>
              <label>
                客户端模型
                <input
                  aria-label="客户端模型"
                  value={cliEditor.model}
                  onChange={(event) =>
                    setCliEditor({
                      ...cliEditor,
                      model: event.currentTarget.value,
                    })
                  }
                />
              </label>
              <label>
                超时（毫秒）
                <input
                  aria-label="客户端超时（毫秒）"
                  inputMode="numeric"
                  value={cliEditor.timeoutMs}
                  onChange={(event) =>
                    setCliEditor({
                      ...cliEditor,
                      timeoutMs: event.currentTarget.value,
                    })
                  }
                />
              </label>
            </div>
            <p className="provider-privacy-copy">
              不会修改、退出或复制客户端账户。
            </p>
            {error === null ? null : (
              <p className="model-provider-dialog-error" role="alert">
                {error}
              </p>
            )}
            <div className="modal-form-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => {
                  setCliEditor(null);
                  setError(null);
                }}
              >
                取消客户端配置
              </button>
              <button type="submit" className="primary-button" disabled={busy}>
                保存客户端
              </button>
            </div>
          </form>
        </ModalDialog>
      )}

      {editor === null ? null : (
        <ModalDialog
          title={
            editor.existing === null
              ? "添加模型后端"
              : `编辑 ${editor.existing.label}`
          }
          description="密钥仅加密保存在本机"
          dismissible={!busy}
          onClose={() => {
            setEditor(null);
            setError(null);
          }}
        >
          <form
            className="model-provider-dialog-form"
            id="model-provider-editor"
            aria-label={
              editor.existing === null
                ? "添加模型后端表单"
                : `编辑 ${editor.existing.label}`
            }
            onSubmit={(event) => {
              event.preventDefault();
              void saveEditor();
            }}
          >
            <div className="provider-form-grid">
              <label>
                后端类型
                <select
                  aria-label="后端类型"
                  autoFocus={editor.existing === null}
                  value={editor.kind}
                  disabled={editor.existing !== null}
                  onChange={(event) => {
                    const kind = event.currentTarget.value as RemoteKind;
                    setEditor((current) =>
                      current === null
                        ? current
                        : {
                            ...current,
                            kind,
                            ...defaultsFor(kind),
                          },
                    );
                  }}
                >
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="openai-compatible">OpenAI 兼容</option>
                </select>
              </label>
              <label>
                显示名称
                <input
                  aria-label="显示名称"
                  autoFocus={editor.existing !== null}
                  value={editor.label}
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      label: event.currentTarget.value,
                    })
                  }
                />
              </label>
              <label>
                模型
                <input
                  aria-label="模型"
                  value={editor.model}
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      model: event.currentTarget.value,
                    })
                  }
                />
              </label>
              <label className="provider-url-field">
                服务地址
                <input
                  aria-label="服务地址"
                  value={editor.baseUrl}
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      baseUrl: event.currentTarget.value,
                    })
                  }
                />
              </label>
              {editor.kind === "openai-compatible" ? (
                <label>
                  API 协议
                  <select
                    aria-label="API 协议"
                    value={editor.apiProtocol}
                    onChange={(event) =>
                      setEditor({
                        ...editor,
                        apiProtocol: event.currentTarget
                          .value as EditorState["apiProtocol"],
                      })
                    }
                  >
                    <option value="responses">Responses</option>
                    <option value="chat-completions">Chat Completions</option>
                  </select>
                </label>
              ) : null}
              <label>
                超时（毫秒）
                <input
                  aria-label="超时（毫秒）"
                  inputMode="numeric"
                  value={editor.timeoutMs}
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      timeoutMs: event.currentTarget.value,
                    })
                  }
                />
              </label>
              <label className="provider-secret-field">
                API 密钥
                <input
                  aria-label="API 密钥"
                  type="password"
                  autoComplete="new-password"
                  value={editor.secret}
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      secret: event.currentTarget.value,
                    })
                  }
                />
                {editor.existing?.credentialConfigured ? (
                  <small>已安全保存，留空则不更换</small>
                ) : null}
              </label>
            </div>
            <p className="provider-privacy-copy">
              此后端会收到语义识别所需的裁剪问答；密钥仅加密保存在本机。
            </p>
            {error === null ? null : (
              <p className="model-provider-dialog-error" role="alert">
                {error}
              </p>
            )}
            <div className="modal-form-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => {
                  setEditor(null);
                  setError(null);
                }}
              >
                {editor.existing === null ? "取消添加" : "取消编辑"}
              </button>
              <button type="submit" className="primary-button" disabled={busy}>
                保存后端
              </button>
            </div>
          </form>
        </ModalDialog>
      )}

      {error === null || editor !== null || cliEditor !== null ? null : (
        <p className="model-provider-message error" role="alert">
          {error}
        </p>
      )}
      {message === null ? null : (
        <p className="model-provider-message" role="status">
          {message}
        </p>
      )}
    </section>
  );
};
