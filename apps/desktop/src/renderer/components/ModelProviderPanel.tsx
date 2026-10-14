import { DEEPSEEK_2026_HOLIDAYS } from "../../shared/model-pricing.js";
import { LocalQwenModelDialog } from "./LocalQwenModelDialog.js";
import { IconButton, ActionIcon } from "./IconButton.js";
import { modelPricingSchema, modelProxySchema, type ModelProxy } from "@cognelis/decision-protocol";
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
  type InputHTMLAttributes,
  type KeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import type {
  DecisionApi,
  ModelProviderTestResult,
} from "../../shared/renderer-api.js";
import { ModalDialog } from "./ModalDialog.js";
import { keepSwitchFocus } from "../keyboard.js";

interface ModelProviderPanelProps {
  api: DecisionApi;
}

type RemoteKind = "openai" | "anthropic" | "openai-compatible";

interface ProxyEditorState { proxyMode: ModelProxy["mode"]; proxyUrl: string; noProxy: string; }
const proxyEditorFor = (profile?: RedactedModelProviderProfile): ProxyEditorState => ({ proxyMode: profile?.proxy?.mode ?? "environment", proxyUrl: profile?.proxy?.url ?? "", noProxy: profile?.proxy?.noProxy ?? "" });
const proxyInput = (state: ProxyEditorState) => modelProxySchema.safeParse(state.proxyMode === "custom" ? { mode: state.proxyMode, url: state.proxyUrl.trim(), noProxy: state.noProxy.trim() } : { mode: state.proxyMode });
const ProxyFields = ({ value, onChange, urlProps }: { value: ProxyEditorState; onChange: (value: ProxyEditorState) => void; urlProps?: InputHTMLAttributes<HTMLInputElement> }) => <fieldset className="provider-proxy-fields"><legend>网络代理</legend><label>连接方式<select aria-label="代理连接方式" value={value.proxyMode} onChange={(event) => onChange({ ...value, proxyMode: event.target.value as ModelProxy["mode"] })}><option value="environment">继承代理环境变量</option><option value="direct">直接连接（不继承代理变量）</option><option value="custom">自定义 HTTP/HTTPS 代理</option></select></label>{value.proxyMode === "custom" && <><label>代理地址<input aria-label="代理地址" {...urlProps} maxLength={2000} placeholder="http://127.0.0.1:7890" value={value.proxyUrl} onChange={(event) => onChange({ ...value, proxyUrl: event.target.value })} /></label><label>不走代理的主机（可选）<input aria-label="代理绕过主机" maxLength={2000} placeholder="localhost,127.0.0.1" value={value.noProxy} onChange={(event) => onChange({ ...value, noProxy: event.target.value })} /></label><p>主机用逗号或空格分隔。留空时不继承原有绕过规则；代理地址不填写账号密码，认证代理可通过环境变量配置。</p></>}<p>每个后端使用自己的代理配置，测试连接也采用相同设置。</p></fieldset>;

interface EditorState extends ProxyEditorState {
  existing: RedactedModelProviderProfile | null;
  kind: RemoteKind;
  label: string;
  model: string;
  baseUrl: string;
  apiProtocol: "responses" | "chat-completions";
  jsonMode: "schema" | "object";
  timeoutMs: string;
  secret: string;
  currency: string;
  inputPrice: string;
  outputPrice: string;
  cachedInputPrice: string;
  pricingMode: "fixed" | "deepseek";
  peakInputPrice: string;
  peakOutputPrice: string;
  peakCachedInputPrice: string;
  holidayYear: string;
  holidays: string;
}

interface CliEditorState extends ProxyEditorState {
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

/**
 * Filling these by hand is error-prone: DeepSeek only accepts json_object,
 * so a profile built with the generic defaults fails at the first call.
 */
const COMPATIBLE_PRESETS = [
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    apiProtocol: "chat-completions" as const,
    jsonMode: "object" as const,
    models: ["deepseek-flash", "deepseek-v4-pro", "deepseek-chat"],
  },
] as const;

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
  ...proxyEditorFor(),
  existing: null,
  kind: "openai",
  ...defaultsFor("openai"),
  jsonMode: "schema",
  model: "",
  timeoutMs: "30000",
  secret: "",
  currency: "",
  inputPrice: "",
  outputPrice: "",
  cachedInputPrice: "", pricingMode: "fixed", peakInputPrice: "", peakOutputPrice: "", peakCachedInputPrice: "", holidayYear: "2026", holidays: DEEPSEEK_2026_HOLIDAYS.join("\n"),
});

const editorFor = (profile: RedactedModelProviderProfile): EditorState => ({
  ...proxyEditorFor(profile),
  existing: profile,
  kind: profile.kind as RemoteKind,
  label: profile.label,
  model: profile.model ?? "",
  baseUrl: profile.baseUrl ?? "",
  apiProtocol:
    profile.apiProtocol === "chat-completions"
      ? "chat-completions"
      : "responses",
  jsonMode: profile.jsonMode === "object" ? "object" : "schema",
  timeoutMs: String(profile.timeoutMs),
  secret: "",
  currency: profile.pricing?.currency ?? "",
  cachedInputPrice: profile.pricing?.cachedInputPerMillion === undefined ? "" : String(profile.pricing.cachedInputPerMillion),
  pricingMode: profile.pricing?.peak ? "deepseek" : "fixed",
  peakInputPrice: profile.pricing?.peak ? String(profile.pricing.peak.inputPerMillion) : "",
  peakOutputPrice: profile.pricing?.peak ? String(profile.pricing.peak.outputPerMillion) : "",
  peakCachedInputPrice: profile.pricing?.peak ? String(profile.pricing.peak.cachedInputPerMillion) : "",
  holidayYear: String(profile.pricing?.peak?.holidayYear ?? 2026),
  holidays: (profile.pricing?.peak?.holidays ?? DEEPSEEK_2026_HOLIDAYS).join("\n"),
  inputPrice:
    profile.pricing === undefined ? "" : String(profile.pricing.inputPerMillion),
  outputPrice:
    profile.pricing === undefined
      ? ""
      : String(profile.pricing.outputPerMillion),
});

/** The site a key goes to: another address on it keeps the key, another site needs its own. */
const siteOf = (value: string | undefined): string | null => {
  try {
    return value === undefined ? null : new URL(value.trim()).origin;
  } catch {
    return null;
  }
};

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

export const tokenSourceCopy: Record<
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

const compactTokens = (value: number): string =>
  value < 1_000 ? `${value}` : `${(value / 1_000).toFixed(1)}k`;

type BackendUsage = { calls: number; reported: number; tokens: number };

// Tokens only as far as the calls reported them, as the activity page counts: none says nothing, some make a floor.
const usageLabel = ({ calls, reported, tokens }: BackendUsage): string =>
  `${calls} 次${reported === 0 ? "" : ` · ${reported < calls ? "至少 " : ""}${compactTokens(tokens)} tokens`}`;

export const ModelProviderPanel = ({ api }: ModelProviderPanelProps) => {
  const [profiles, setProfiles] = useState<
    RedactedModelProviderProfile[] | null
  >(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [localEditor, setLocalEditor] = useState<RedactedModelProviderProfile | null>(null);
  const [cliEditor, setCliEditor] = useState<CliEditorState | null>(null);
  // What each editor opened with: changed since, Escape no longer closes it with the address, model and key typed.
  const [editorOpenedWith, setEditorOpenedWith] = useState<EditorState | null>(null);
  const [cliEditorOpenedWith, setCliEditorOpenedWith] = useState<CliEditorState | null>(null);
  const openEditor = (opened: EditorState): void => {
    setEditor(opened);
    setEditorOpenedWith(opened);
  };
  const openCliEditor = (opened: CliEditorState): void => {
    setCliEditor(opened);
    setCliEditorOpenedWith(opened);
  };
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A value refused is said on its field, and the field is where focus goes (as ActiveRecordDialog's fieldProps do):
  // said only below the form, a VoiceOver user heard it once from 保存 and then looked for a field that said nothing.
  const fieldIds = useId();
  const [invalidField, setInvalidField] = useState<string | null>(null);
  const refuse = (field: string, text: string): void => {
    setError(text);
    setInvalidField(field);
    document.getElementById(`${fieldIds}${field}`)?.focus();
  };
  const fieldProps = (field: string) => ({
    id: `${fieldIds}${field}`,
    "aria-invalid": (error !== null && invalidField === field) || undefined,
    "aria-describedby": error !== null && invalidField === field ? `${fieldIds}error` : undefined,
  });
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<
    Record<string, ModelProviderTestResult>
  >({});
  const [clientStatuses, setClientStatuses] = useState<
    LocalModelClientStatus[] | null
  >(null);
  const [draggedProfileId, setDraggedProfileId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<ProviderDropTarget | null>(null);
  // How much each backend was used, from the local call records: worth weighing when ordering or pricing them.
  const [usage, setUsage] = useState<ReadonlyMap<string, BackendUsage>>(new Map());
  useEffect(() => {
    let active = true;
    void api.listModelTraces().then((traces) => {
      if (!active) return;
      const byProfile = new Map<string, BackendUsage>();
      for (const trace of traces) {
        const seen = byProfile.get(trace.profile.profileId) ?? { calls: 0, reported: 0, tokens: 0 };
        const tokens = trace.usage.totalTokens;
        byProfile.set(trace.profile.profileId, { calls: seen.calls + 1, reported: seen.reported + (tokens === undefined ? 0 : 1), tokens: seen.tokens + (tokens ?? 0) });
      }
      setUsage(byProfile);
    }).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api]);

  const profileValues = profiles ?? [];
  const addingRemote = editor?.existing === null;

  // The newest read of the clients' status is the one shown: the first, still checking a slow client, came back
  // after 刷新模型候选 had and took its candidates away.
  const statusRead = useRef(0);
  const load = async (): Promise<void> => {
    const read = ++statusRead.current;
    const [profileValues, statusValues] = await Promise.all([
      api.listModelProviderProfiles(),
      api.listLocalModelClientStatuses(),
    ]);
    setProfiles(profileValues);
    if (read === statusRead.current) setClientStatuses(statusValues);
  };

  // A read that failed said "正在读取…" for good, with nothing to try again with.
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const readProfiles = (isActive: () => boolean = () => true): void => {
    setProfilesError(null);
    void api.listModelProviderProfiles().then(
      (values) => {
        if (isActive()) setProfiles(values);
      },
      (caught: unknown) => {
        if (isActive()) setProfilesError(caught instanceof Error ? caught.message : String(caught));
      },
    );
  };

  useEffect(() => {
    let active = true;
    readProfiles(() => active);
    const read = ++statusRead.current;
    void api.listLocalModelClientStatuses().then(
      (values) => {
        if (active && read === statusRead.current) setClientStatuses(values);
      },
      // Said on each client as no status returned, not checked for ever.
      () => {
        if (active && read === statusRead.current) setClientStatuses([]);
      },
    );
    return () => {
      active = false;
    };
  }, [api]);

  const run = async (operation: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    setInvalidField(null);
    setMessage(null);
    try {
      await operation();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setBusy(false);
    }
  };
  // A test run before a change says nothing about the backend as it is now.
  const forgetTest = (profileId: string): void =>
    setTestResults(({ [profileId]: _stale, ...rest }) => rest);

  const saveEditor = async (): Promise<void> => {
    if (editor === null) {
      return;
    }
    if (editor.label.trim().length === 0) {
      refuse("label", "请输入后端名称。");
      return;
    }
    if (editor.model.trim().length === 0) {
      refuse("model", "请输入模型名称。");
      return;
    }
    if (!secureEndpoint(editor.baseUrl)) {
      refuse("baseUrl", "服务地址必须使用 HTTPS 或本机回环地址。");
      return;
    }
    const timeoutMs = Number(editor.timeoutMs);
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1_000 ||
      timeoutMs > 120_000
    ) {
      refuse("timeoutMs", "超时时间必须在 1000 到 120000 毫秒之间。");
      return;
    }
    if (editor.existing === null && editor.secret.trim().length === 0) {
      refuse("secret", "请输入 API 密钥。");
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
    const proxy = proxyInput(editor);
    if (!proxy.success) { refuse("proxyUrl", "请填写有效的 HTTP/HTTPS 代理地址，不包含账号密码、路径或查询参数。"); return; }
    // A rate begun is finished or said to be wrong, never dropped: saved without it, the backend
    // would lose the price it had, and every cost estimate with it, under "saved".
    const rate = [editor.currency, editor.inputPrice, editor.outputPrice].map((value) => value.trim());
    const priced = rate.some((value) => value.length > 0) || editor.cachedInputPrice.trim().length > 0 || editor.pricingMode === "deepseek";
    const perMillion = (value: string): boolean =>
      value.trim().length > 0 && Number(value) >= 0 && Number(value) <= 1_000_000;
    const unpriced = !(rate[0]!.length > 0 && rate[0]!.length <= 8) ? "currency" : !perMillion(rate[1]!) ? "inputPrice" : !perMillion(rate[2]!) ? "outputPrice" : null;
    if (priced && unpriced !== null) {
      refuse(unpriced, "计费单价要三项都填：货币，以及每百万 token 的输入、输出单价（0 到 1000000 的数字）；不记成本就三项都留空。");
      return;
    }
    if (editor.cachedInputPrice.trim() && !perMillion(editor.cachedInputPrice)) { refuse("cachedInputPrice", "缓存命中单价必须为 0 到 1000000 的数字。"); return; }
    if (editor.pricingMode === "deepseek") {
      for (const field of ["cachedInputPrice", "peakInputPrice", "peakOutputPrice", "peakCachedInputPrice"] as const) {
        if (!perMillion(editor[field])) { refuse(field, "峰谷计费的六个单价必须全部填写，范围为 0 到 1000000。"); return; }
      }
    }
    const parsedPricing = priced ? modelPricingSchema.safeParse({
      currency: editor.currency.trim(), inputPerMillion: Number(editor.inputPrice), outputPerMillion: Number(editor.outputPrice),
      ...(editor.cachedInputPrice.trim() ? { cachedInputPerMillion: Number(editor.cachedInputPrice) } : {}),
      ...(editor.pricingMode === "deepseek" ? { peak: { inputPerMillion: Number(editor.peakInputPrice), outputPerMillion: Number(editor.peakOutputPrice), cachedInputPerMillion: Number(editor.peakCachedInputPrice), holidayYear: Number(editor.holidayYear), holidays: [...new Set(editor.holidays.split(/[\s,，]+/u).filter(Boolean))] } } : {}),
    }) : undefined;
    if (parsedPricing && !parsedPricing.success) { refuse(parsedPricing.error.issues.some((issue) => issue.path.includes("holidayYear")) ? "holidayYear" : "holidays", "请填写有效的日历年份和该年份的节假日日期（YYYY-MM-DD，每行一个）。"); return; }
    const profile: RedactedModelProviderProfile = {
      proxy: proxy.data,
      ...(editor.existing?.fallbackOnFailure === undefined ? {} : { fallbackOnFailure: editor.existing.fallbackOnFailure }),
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
      ...(editor.kind === "openai-compatible" && editor.jsonMode === "object"
        ? { jsonMode: "object" as const }
        : {}),
      // Only a complete rate becomes a price (checked above): two of three
      // fields would turn into a number that reads exact and is not.
      ...(parsedPricing?.success ? { pricing: parsedPricing.data } : {}),
      credentialConfigured: editor.existing?.credentialConfigured ?? false,
    };
    let saved = false;
    await run(async () => {
      await api.saveModelProviderProfile({
        profile,
        ...(editor.secret.length === 0 ? {} : { secret: editor.secret }),
      });
      saved = true;
      forgetTest(profile.profileId);
      setMessage("模型后端已保存。");
      await load();
    });
    // Closed once nothing is busy, so the button that opened it is enabled again to take focus back.
    if (saved) setEditor(null);
  };

  const reorder = (
    sourceProfileId: string,
    targetProfileId: string,
    edge: ProviderDropTarget["edge"],
  ): Promise<unknown> => {
    if (sourceProfileId === targetProfileId) {
      return Promise.resolve();
    }
    const currentOrder = profileValues.map((profile) => profile.profileId);
    const order = currentOrder.filter(
      (profileId) => profileId !== sourceProfileId,
    );
    const targetIndex = order.indexOf(targetProfileId);
    if (targetIndex < 0) {
      return Promise.resolve();
    }
    order.splice(targetIndex + (edge === "after" ? 1 : 0), 0, sourceProfileId);
    if (order.every((profileId, index) => profileId === currentOrder[index])) {
      return Promise.resolve();
    }
    return run(async () => {
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
    // Disabled while it moves and moved in the list, the handle would lose focus, and the next arrow
    // key would scroll the page instead of moving the row again.
    keepSwitchFocus(
      event.currentTarget,
      reorder(
        source.profileId,
        target.profileId,
        offset === -1 ? "before" : "after",
      ),
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
      refuse("cliPath", "客户端路径必须是绝对路径。");
      return;
    }
    const timeoutMs = Number(cliEditor.timeoutMs);
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1_000 ||
      timeoutMs > 120_000
    ) {
      refuse("cliTimeout", "超时时间必须在 1000 到 120000 毫秒之间。");
      return;
    }
    const proxy = proxyInput(cliEditor);
    if (!proxy.success) { refuse("cliProxyUrl", "请填写有效的 HTTP/HTTPS 代理地址，不包含账号密码、路径或查询参数。"); return; }
    const { model: _existingModel, ...withoutModel } = cliEditor.profile;
    let saved = false;
    await run(async () => {
      await api.saveModelProviderProfile({
        profile: {
          ...withoutModel,
          proxy: proxy.data,
          executablePath: cliEditor.executablePath,
          timeoutMs,
          ...(cliEditor.model.trim().length === 0
            ? {}
            : { model: cliEditor.model.trim() }),
        },
      });
      saved = true;
      forgetTest(cliEditor.profile.profileId);
      setMessage("本地客户端配置已保存。");
      await load();
    });
    if (saved) setCliEditor(null);
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
          <span>按顺序尝试，可配置失败后是否继续</span>
        </div>
        <button
          type="button"
          className="secondary-button model-provider-add-button"
          aria-haspopup="dialog"
          aria-expanded={addingRemote}
          disabled={
            busy || profiles === null || cliEditor !== null || (editor !== null && !addingRemote)
          }
          onClick={() => {
            openEditor(newEditor());
            setError(null);
            setMessage(null);
          }}
        >
          添加模型后端
        </button>
      </header>

      {profiles === null && profilesError !== null ? (
        <div className="model-provider-list model-provider-loading">
          <p className="error-message" role="alert">
            模型后端暂时无法读取：{profilesError}
          </p>
          <button type="button" className="secondary-button" onClick={() => readProfiles()}>
            重新读取
          </button>
        </div>
      ) : profiles === null ? (
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
            const clientDetail = clientStatus?.version === undefined ? "本地客户端" : `v${clientStatus.version}`;
            // A CLI runs here and sends what it is given to its vendor's service: shown by its version alone, it
            // read as a model on this Mac, and was enabled for unattended capture classification as one.
            const statusDetail = localClient
              ? sendsRemote
                ? `${clientDetail} · 远程调用`
                : clientDetail
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
                <div className="provider-row" data-disabled={profile.enabled ? undefined : true}>
                  <IconButton
                    type="button"
                    className="provider-drag-handle"
                    draggable={!busy}
                    disabled={busy}
                    aria-label={`拖拽排序 ${profile.label}，可用上下方向键调整`}

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
                  </IconButton>
                  <div className="provider-copy">
                    <strong title={profile.label}>{profile.label}</strong>
                    <span>
                      {kindLabel[profile.kind]}
                      {profile.model === undefined ? "" : ` · ${profile.model}`}
                      {remoteCallingKinds.has(profile.kind) ? ` · ${profile.proxy?.mode === "custom" ? "自定义代理" : profile.proxy?.mode === "direct" ? "直接连接" : "继承代理环境"}` : ""}
                    </span>
                    {usage.get(profile.profileId) === undefined ? null : (
                      <small className="provider-usage">
                        调用记录：{usageLabel(usage.get(profile.profileId)!)}
                      </small>
                    )}
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
                  {/* The main switch, named on screen; failing over is a setting of an enabled backend. */}
                  <label className="provider-switch provider-enable-control" title={`${profile.label} 启停`}>
                    启用
                    <input
                      type="checkbox"
                      role="switch"
                      checked={profile.enabled}
                      disabled={busy}
                      aria-label={`启用 ${profile.label}`}
                      onChange={(event) => {
                        const enabled = event.currentTarget.checked;
                        keepSwitchFocus(event.currentTarget, run(async () => {
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
                        }));
                      }}
                    />
                  </label>
                  <label className="provider-fallback-control">失败后切换<input type="checkbox" role="switch" aria-label={`${profile.label} 失败后切换`} checked={profile.fallbackOnFailure !== false} disabled={busy || !profile.enabled} onChange={(event) => { const fallbackOnFailure = event.currentTarget.checked; keepSwitchFocus(event.currentTarget, run(async () => { await api.saveModelProviderProfile({ profile: { ...profile, fallbackOnFailure } }); await load(); })); }} /></label>
                  <div className="provider-actions">
                    <IconButton
                      type="button"

                      disabled={busy}
                      aria-label={`测试 ${profile.label}`}
                      onClick={(event) =>
                        keepSwitchFocus(event.currentTarget, run(async () => {
                          const result = await api.testModelProviderProfile(
                            profile.profileId,
                          );
                          setTestResults((current) => ({
                            ...current,
                            [profile.profileId]: result,
                          }));
                        }))
                      }
                    >
                      <ActionIcon name="test" />
                    </IconButton>
                    {profile.kind === "qwen" ? <IconButton type="button" aria-haspopup="dialog" aria-label={`配置 ${profile.label}`} disabled={busy || localEditor !== null} onClick={() => setLocalEditor(profile)}><ActionIcon name="settings" /></IconButton> : null}
                    {localClient ? (
                      <IconButton
                        type="button"

                        aria-haspopup="dialog"
                        disabled={busy || editor !== null || cliEditor !== null}
                        aria-label={`配置 ${profile.label}`}
                        onClick={() => {
                          openCliEditor({
                            ...proxyEditorFor(profile),
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
                        <ActionIcon name="settings" />
                      </IconButton>
                    ) : null}
                    {remote ? (
                      <>
                        <IconButton
                          type="button"

                          aria-haspopup="dialog"
                          disabled={busy || editor !== null}
                          aria-label={`编辑 ${profile.label}`}
                          onClick={() => {
                            openEditor(editorFor(profile));
                            setError(null);
                            setMessage(null);
                          }}
                        >
                          <ActionIcon name="edit" />
                        </IconButton>
                        <IconButton
                          type="button"
                          className={deleting ? "icon-button-confirm danger-text" : "danger-text"}
                          disabled={busy}
                          aria-label={
                            deleting
                              ? `确认删除 ${profile.label}`
                              : `删除 ${profile.label}`
                          }
                          // Armed until the reader goes elsewhere: kept, one stray click on it minutes and other
                          // actions later deleted the backend and its key.
                          onBlur={() => {
                            if (deleting) setDeleteTarget(null);
                          }}
                          onClick={(event) => {
                            if (!deleting) {
                              setDeleteTarget(profile.profileId);
                              return;
                            }
                            // The second click of a double-click lands on the confirmation the first just put
                            // there: only a click of its own confirms, the one the reader saw it before.
                            if (event.detail > 1) return;
                            void run(async () => {
                              await api.deleteModelProviderProfile(
                                profile.profileId,
                              );
                              setDeleteTarget(null);
                              await load();
                            });
                          }}
                        >
                          {deleting ? "确认删除" : <ActionIcon name="trash" />}
                        </IconButton>
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

      {localEditor === null ? null : <LocalQwenModelDialog api={api} profile={localEditor} onClose={() => setLocalEditor(null)} onSaved={load} />}
      {cliEditor === null ? null : (
        <ModalDialog
          title={`配置 ${cliEditor.profile.label}`}
          description="使用客户端现有登录状态"
          dismissible={!busy && JSON.stringify(cliEditor) === JSON.stringify(cliEditorOpenedWith)}
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
                  {...fieldProps("cliPath")}
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
                  list={`${fieldIds}cli-models`}
                  value={cliEditor.model}
                  onChange={(event) =>
                    setCliEditor({
                      ...cliEditor,
                      model: event.currentTarget.value,
                    })
                  }
                />
              </label>
              <datalist id={`${fieldIds}cli-models`}>
                {(clientStatuses?.find(status => status.kind === cliEditor.profile.kind)?.models ?? []).map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
              </datalist>
              <label>
                超时（毫秒）
                <input
                  aria-label="客户端超时（毫秒）"
                  {...fieldProps("cliTimeout")}
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
            <ProxyFields value={cliEditor} onChange={(proxy) => setCliEditor({ ...cliEditor, ...proxy })} urlProps={fieldProps("cliProxyUrl")} />
            <p className="provider-privacy-copy">可选择候选或手动输入；留空使用客户端默认模型。{(() => {
              const source = clientStatuses?.find(status => status.kind === cliEditor.profile.kind)?.modelsSource;
              return source === "server" ? "候选来源：服务端直查。" : source === "client" ? "候选来源：CLI 目录（可能使用客户端内部缓存）。" : source === "cache" ? "候选来源：本机缓存（服务端及 CLI 查询未成功）。" : "尚无模型候选；刷新时依次尝试服务端、CLI 目录和本机缓存。";
            })()}</p>
            <p className="provider-privacy-copy">
              内容经本机客户端发送给 {cliEditor.profile.kind === "codex-cli" ? "OpenAI" : "Anthropic"} 的模型服务，可能消耗额度；不会修改、退出或复制客户端账户。
            </p>
            {error === null ? null : (
              <p className="model-provider-dialog-error" role="alert" id={`${fieldIds}error`}>
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
              <button type="button" className="secondary-button" disabled={busy} onClick={() => void run(load)}>刷新模型候选</button>
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
          description="密钥仅保存在本机，存储方式遵循「通用」中的密钥设置"
          dismissible={!busy && JSON.stringify(editor) === JSON.stringify(editorOpenedWith)}
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
                  {...fieldProps("label")}
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
              {editor.kind === "openai-compatible" ? (
                <div className="provider-presets">
                  <span>服务预设</span>
                  {COMPATIBLE_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      className="text-button"
                      onClick={() =>
                        setEditor({
                          ...editor,
                          label: preset.label,
                          baseUrl: preset.baseUrl,
                          apiProtocol: preset.apiProtocol,
                          jsonMode: preset.jsonMode,
                          model:
                            editor.model.trim().length === 0
                              ? preset.models[0]
                              : editor.model,
                        })
                      }
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              ) : null}
              <label>
                模型
                <input
                  aria-label="模型"
                  {...fieldProps("model")}
                  list="provider-model-suggestions"
                  value={editor.model}
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      model: event.currentTarget.value,
                    })
                  }
                />
                <datalist id="provider-model-suggestions">
                  {COMPATIBLE_PRESETS.flatMap((preset) =>
                    preset.models.map((model) => (
                      <option key={`${preset.id}:${model}`} value={model} />
                    )),
                  )}
                </datalist>
              </label>
              <label className="provider-url-field">
                服务地址
                <input
                  aria-label="服务地址"
                  {...fieldProps("baseUrl")}
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
              {editor.kind === "openai-compatible" ? (
                <label>
                  JSON 输出
                  <select
                    aria-label="JSON 输出"
                    value={editor.jsonMode}
                    onChange={(event) =>
                      setEditor({
                        ...editor,
                        jsonMode: event.currentTarget
                          .value as EditorState["jsonMode"],
                      })
                    }
                  >
                    <option value="schema">严格 Schema</option>
                    <option value="object">JSON 对象（DeepSeek 等）</option>
                  </select>
                </label>
              ) : null}
              <label>
                超时（毫秒）
                <input
                  aria-label="超时（毫秒）"
                  {...fieldProps("timeoutMs")}
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
              <fieldset className="provider-pricing-fields">
                <legend>计费单价（可选）</legend>
                <div className="provider-form-grid">
                <label>计费方式<select aria-label="计费方式" value={editor.pricingMode} onChange={(event) => setEditor({ ...editor, pricingMode: event.currentTarget.value === "deepseek" ? "deepseek" : "fixed" })}><option value="fixed">固定单价</option><option value="deepseek">DeepSeek 峰谷计费</option></select></label>
                <label>参考价格<button type="button" className="secondary-button" aria-label="填入 DeepSeek Flash 参考价格" disabled={editor.model.trim() !== "deepseek-flash"} onClick={() => setEditor({ ...editor, pricingMode: "deepseek", currency: "¥", inputPrice: "1", cachedInputPrice: "0.02", outputPrice: "4", peakInputPrice: "2", peakCachedInputPrice: "0.04", peakOutputPrice: "8", holidayYear: "2026", holidays: DEEPSEEK_2026_HOLIDAYS.join("\n") })}>填入 Flash 参考价</button></label>

                <label>
                  货币
                  <input
                    aria-label="货币"
                    {...fieldProps("currency")}
                    maxLength={8}
                    placeholder="¥"
                    value={editor.currency}
                    onChange={(event) =>
                      setEditor({
                        ...editor,
                        currency: event.currentTarget.value,
                      })
                    }
                  />
                </label>
                </div>
                <label>{editor.pricingMode === "deepseek" ? "空闲时段 · 缓存命中输入 / 百万 token" : "缓存命中输入 / 百万 token（可选）"}<input aria-label="缓存命中输入单价" {...fieldProps("cachedInputPrice")} inputMode="decimal" value={editor.cachedInputPrice} onChange={(event) => setEditor({ ...editor, cachedInputPrice: event.currentTarget.value })} /></label>
                <label>
                  {editor.pricingMode === "deepseek" ? "空闲时段 · 缓存未命中输入 / 百万 token" : "输入 / 百万 token"}
                  <input
                    aria-label="输入单价"
                    {...fieldProps("inputPrice")}
                    inputMode="decimal"
                    placeholder="1.0"
                    value={editor.inputPrice}
                    onChange={(event) =>
                      setEditor({
                        ...editor,
                        inputPrice: event.currentTarget.value,
                      })
                    }
                  />
                </label>
                <label>
                  {editor.pricingMode === "deepseek" ? "空闲时段 · 输出 / 百万 token" : "输出 / 百万 token"}
                  <input
                    aria-label="输出单价"
                    {...fieldProps("outputPrice")}
                    inputMode="decimal"
                    placeholder="2.0"
                    value={editor.outputPrice}
                    onChange={(event) =>
                      setEditor({
                        ...editor,
                        outputPrice: event.currentTarget.value,
                      })
                    }
                  />
                </label>
                {editor.pricingMode === "deepseek" ? <>
                  {([["peakCachedInputPrice", "高峰缓存命中输入单价"], ["peakInputPrice", "高峰缓存未命中输入单价"], ["peakOutputPrice", "高峰输出单价"]] as const).map(([field, label]) => <label key={field}>{label} / 百万 token<input aria-label={label} {...fieldProps(field)} inputMode="decimal" value={editor[field]} onChange={(event) => setEditor({ ...editor, [field]: event.currentTarget.value })} /></label>)}
                  <label>节假日日历年份<input aria-label="节假日日历年份" {...fieldProps("holidayYear")} inputMode="numeric" value={editor.holidayYear} onChange={(event) => setEditor({ ...editor, holidayYear: event.currentTarget.value })} /></label>
                  <label className="provider-secret-field">全天按空闲价的节假日<textarea aria-label="空闲价节假日" {...fieldProps("holidays")} rows={3} value={editor.holidays} onChange={(event) => setEditor({ ...editor, holidays: event.currentTarget.value })} /></label>
                  <p>北京时间周一至周五 09:00–12:00、14:00–18:00 为高峰。周末（含调休上班日）与已配置节假日全天为空闲。未覆盖年份或缓存用量缺失时显示估算范围。</p>
                </> : null}
                <p>价格由你配置；参考价核对于 2026-10-12。新调用保留当时价格，旧记录按当前价格估算。费用以服务商账单为准。</p>
              </fieldset>
              <label className="provider-secret-field">
                API 密钥
                <input
                  aria-label="API 密钥"
                  {...fieldProps("secret")}
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
                  // Moved to another site (a preset, a relay), the saved key is not sent there: said before the save is refused.
                  <small>
                    {siteOf(editor.baseUrl) !== null && siteOf(editor.baseUrl) !== siteOf(editor.existing.baseUrl)
                      ? "地址换到了另一个站点，需要填写这个站点的 API 密钥"
                      : "已安全保存，留空则不更换"}
                  </small>
                ) : null}
              </label>
            </div>
            <p className="provider-privacy-copy">
              此后端会收到语义识别所需的裁剪问答；密钥仅保存在本机，存储方式遵循「通用」中的密钥设置。
            </p>
            <ProxyFields value={editor} onChange={(proxy) => setEditor({ ...editor, ...proxy })} urlProps={fieldProps("proxyUrl")} />
            {error === null ? null : (
              <p className="model-provider-dialog-error" role="alert" id={`${fieldIds}error`}>
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
