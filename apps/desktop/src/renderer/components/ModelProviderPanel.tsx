import { DEEPSEEK_2026_HOLIDAYS } from "../../shared/model-pricing.js";
import { LocalQwenModelDialog } from "./LocalQwenModelDialog.js";
import { IconButton, ActionIcon } from "./IconButton.js";
import { modelPricingSchema, modelProxySchema, OPENROUTER_DECISIONS_URL, type ModelProxy } from "@cognelis/decision-protocol";
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
  type ReactNode,
  useCallback,
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

interface ProxyEditorState { proxyMode: ModelProxy["mode"]; proxyUrl: string; }
const proxyEditorFor = (profile?: RedactedModelProviderProfile): ProxyEditorState => ({ proxyMode: profile?.proxy?.mode ?? "environment", proxyUrl: profile?.proxy?.url ?? "" });
const proxyInput = (state: ProxyEditorState) => modelProxySchema.safeParse(state.proxyMode === "custom" ? { mode: state.proxyMode, url: state.proxyUrl.trim() } : { mode: state.proxyMode });
/** A backend's own proxy: how it connects, and where to when that is a proxy of its own (the forms' field layout). */
const ProxyFields = ({ id, value, onChange, urlProps, urlError, allowLoopback = true }: { allowLoopback?: boolean; id: string; value: ProxyEditorState; onChange: (value: ProxyEditorState) => void; urlProps: InputHTMLAttributes<HTMLInputElement>; urlError: ReactNode }) => <>
  <div className="form-field">
    <label htmlFor={`${id}proxy-mode`}>网络代理</label>
    <select id={`${id}proxy-mode`} aria-describedby={`${id}proxy-help`} value={value.proxyMode} onChange={(event) => onChange({ ...value, proxyMode: event.target.value as ModelProxy["mode"] })}><option value="environment">使用全局模型代理</option>{allowLoopback ? <option value="direct">仅本机 loopback 直连</option> : value.proxyMode === "direct" ? <option value="direct" disabled>直连已禁用，请选择代理</option> : null}<option value="custom">自定义 HTTP/HTTPS 代理</option></select>
    <p id={`${id}proxy-help`}>外部模型必须经过代理。可在本页上方设置全局代理；未配置全局代理时使用这里的自定义地址。无有效代理或代理故障时请求失败，CLI 也遵守相同策略。</p>
  </div>
  {value.proxyMode === "custom" ? <div className="form-fields-row">
    <div className="form-field">
      <label htmlFor={urlProps.id}>代理地址</label>
      <input {...urlProps} maxLength={2000} placeholder="http://127.0.0.1:7890" value={value.proxyUrl} onChange={(event) => onChange({ ...value, proxyUrl: event.target.value })} />
      {urlError}
      <p>不填写账号密码；认证代理通过 MODEL_PROXY_URL 配置。</p>
    </div>
  </div> : null}
</>;

/** A datalist offers only the options containing what is already typed: with gpt-6-luna filled in, Codex's eight models showed as
 *  its two Luna ones. A menu lists every candidate, marks the one in use, and the field beside it still takes any name typed. */
const ModelCandidates = ({ models, value, onPick }: { models: readonly { id: string; label?: string }[]; value: string; onPick: (model: string) => void }) => {
  if (models.length === 0) return null;
  // Matched by nothing, React would mark the first candidate as the one in use.
  const current = models.some((model) => model.id === value) ? value : "";
  return <select aria-label="选择候选模型" value={current} onChange={(event) => onPick(event.currentTarget.value)}>
    {current === "" ? <option value="" disabled>选择候选模型</option> : null}
    {models.map((model) => <option key={model.id} value={model.id}>{model.label ?? model.id}</option>)}
  </select>;
};

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

interface JudgeEditorState extends ProxyEditorState {
  existing: RedactedModelProviderProfile | null;
  label: string;
  endpoint: string;
  protocol: "systemone" | "openai";
  model: string;
  timeoutMs: string;
  secret: string;
}

/** A decisions backend (a judge): in an ordered list of its own, apart from the one every generation route goes down. */
const JUDGE_KIND = "openrouter-decisions";
const judgeEditorFor = (profile?: RedactedModelProviderProfile): JudgeEditorState => ({
  ...proxyEditorFor(profile),
  existing: profile ?? null,
  label: profile?.label ?? "jev",
  endpoint: profile?.baseUrl ?? OPENROUTER_DECISIONS_URL,
  protocol: profile?.decisionsProtocol ?? "systemone",
  model: profile?.model ?? "typesafe/jev-1.14",
  timeoutMs: String(profile?.timeoutMs ?? 30_000),
  secret: "",
});

/** The decisions APIs known by their address and request shape; any other is typed in. */
const JUDGE_PRESETS = [
  { label: "OpenRouter", endpoint: OPENROUTER_DECISIONS_URL, protocol: "systemone", model: "typesafe/jev-1.14" },
  { label: "OpenAI", endpoint: "https://api.openai.com/v1/decisions", protocol: "openai", model: "gpt-6-luna" },
] as const;

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
  "openrouter-decisions": "判定模型",
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
  if (status.availability === "proxy_required") {
    return "需要配置网络代理";
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

/** A key typed for one site is not kept for another: moved (a preset, a new address), the dialog asks for that site's. */
const keyFor = (secret: string, from: string, to: string): string => (siteOf(from) === siteOf(to) ? secret : "");

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
  content_refused: "内容被服务商审核拒绝",
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
    result.costUsd === undefined ? undefined : `费用 $${result.costUsd}`,
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
  const [judgeEditor, setJudgeEditor] = useState<JudgeEditorState | null>(null);
  const [judgeEditorOpenedWith, setJudgeEditorOpenedWith] = useState<JudgeEditorState | null>(null);
  const openJudgeEditor = (opened: JudgeEditorState): void => {
    setJudgeEditor(opened);
    setJudgeEditorOpenedWith(opened);
    setError(null);
    setMessage(null);
  };
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
  const [pendingProfiles, setPendingProfiles] = useState<Record<string, boolean>>({});
  const [profileErrors, setProfileErrors] = useState<Record<string, string>>({});
  const profileUpdates = useRef(new Map<string, RedactedModelProviderProfile | null>());
  const rowBusy = (profileId: string): boolean => busy || pendingProfiles[profileId] === true;
  const orderingBlocked = busy || Object.keys(pendingProfiles).length > 0;
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
  // Described by what was refused about it first, then by its own help, as both are read under it.
  const fieldProps = (field: string, help = false) => {
    const refused = error !== null && invalidField === field;
    return {
      id: `${fieldIds}${field}`,
      "aria-invalid": refused || undefined,
      "aria-describedby": [refused ? `${fieldIds}error` : "", help ? `${fieldIds}${field}-help` : ""].filter(Boolean).join(" ") || undefined,
    };
  };
  // What was refused, under the field it is about: said only below the form, it sat out of sight at the foot of a
  // long one, and the save looked as if it had done nothing.
  const fieldError = (field: string) => error !== null && invalidField === field
    ? <p className="form-field-error" role="alert" id={`${fieldIds}error`}>{error}</p> : null;
  /** One field as the forms draw it: its label, the control, what was refused about it, then its help. */
  const formField = (field: string, label: string, control: ReactNode, help?: ReactNode) => <div className="form-field">
    <label htmlFor={`${fieldIds}${field}`}>{label}</label>
    {control}
    {fieldError(field)}
    {help ? <p id={`${fieldIds}${field}-help`}>{help}</p> : null}
  </div>;
  // A failure that belongs to no field (a save the keychain refused) is said at the form's foot: brought into view, as
  // the body may be scrolled away from there.
  const revealError = useCallback((node: HTMLElement | null) => { node?.scrollIntoView?.({ block: "nearest" }); }, []);
  const formError = error !== null && invalidField === null
    ? <p className="form-error" role="alert" id={`${fieldIds}error`} ref={revealError}>{error}</p> : null;
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  // Armed while focus stays on the bin or the question under its row: gone elsewhere, a stray click minutes and other
  // actions later cannot delete the backend and its key.
  const keepsDeleteArmed = (next: EventTarget | null, profileId: string): boolean =>
    next instanceof Element && next.closest(`[data-delete-for="${profileId}"]`) !== null;
  const disarmDelete = (profileId: string): void => {
    setDeleteTarget(null);
    document.querySelector<HTMLElement>(`button[data-delete-for="${profileId}"]`)?.focus();
  };
  const [testResults, setTestResults] = useState<
    Record<string, ModelProviderTestResult>
  >({});
  const [testingProfiles, setTestingProfiles] = useState<Record<string, boolean>>({});
  const [testErrors, setTestErrors] = useState<Record<string, string>>({});
  const [clientStatuses, setClientStatuses] = useState<
    LocalModelClientStatus[] | null
  >(null);
  const [draggedProfileId, setDraggedProfileId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<ProviderDropTarget | null>(null);
  // How much each backend was used, from the local call records: worth weighing when ordering or pricing them.
  const [usage, setUsage] = useState<ReadonlyMap<string, BackendUsage>>(new Map());
  const [globalProxy, setGlobalProxy] = useState<{ url: string; environmentOverride: boolean } | null>(null);
  const [globalProxySaving, setGlobalProxySaving] = useState(false);
  const [globalProxyError, setGlobalProxyError] = useState<string | null>(null);
  const [globalProxyMessage, setGlobalProxyMessage] = useState<string | null>(null);
  const globalProxyInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let active = true;
    void api.getSnapshot().then(snapshot => {
      if (active) setGlobalProxy({ url: snapshot.modelProxyUrl ?? "", environmentOverride: snapshot.modelProxyEnvironmentOverride ?? false });
    }, () => { if (active) setGlobalProxyError("全局代理暂时读取失败，请重新打开模型页。"); });
    return () => { active = false; };
  }, [api]);
  const saveGlobalProxy = async (): Promise<void> => {
    if (globalProxy === null || globalProxySaving) return;
    const url = globalProxy.url.trim();
    setGlobalProxyError(null); setGlobalProxyMessage(null);
    if (url && !modelProxySchema.safeParse({ mode: "custom", url }).success) {
      setGlobalProxyError("请填写 HTTP/HTTPS 代理地址，不包含账号密码、路径或查询参数。");
      globalProxyInput.current?.focus(); return;
    }
    setGlobalProxySaving(true);
    try {
      await api.setModelProxyUrl(url || null);
      setGlobalProxy(current => current === null ? current : { ...current, url });
      await load();
      setGlobalProxyMessage("全局模型代理已保存，客户端状态已刷新。");
    } catch { setGlobalProxyError("保存或刷新全局代理失败，请重试。"); }
    finally { setGlobalProxySaving(false); }
  };

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

  const allProfiles = profiles ?? [];
  const profileValues = allProfiles.filter((profile) => profile.kind !== JUDGE_KIND);
  const judgeProfiles = allProfiles.filter((profile) => profile.kind === JUDGE_KIND);
  const isJudge = (profileId: string): boolean => judgeProfiles.some((profile) => profile.profileId === profileId);
  const addingRemote = editor?.existing === null;

  // The newest read of the clients' status is the one shown: the first, still checking a slow client, came back
  // after 刷新模型候选 had and took its candidates away.
  const statusRead = useRef(0);
  const load = async (): Promise<void> => {
    const updatesBefore = new Map(profileUpdates.current);
    const read = ++statusRead.current;
    const [profileValues, statusValues] = await Promise.all([
      api.listModelProviderProfiles(),
      api.listLocalModelClientStatuses(),
    ]);
    // A row saved or deleted while this read waited for clients keeps its newer state.
    setProfiles(profileValues.flatMap((profile) => {
      const updated = profileUpdates.current.get(profile.profileId);
      return updated !== undefined && updated !== updatesBefore.get(profile.profileId)
        ? updated === null ? [] : [updated]
        : [profile];
    }));
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

  const run = async (operation: () => Promise<void>, profileId?: string): Promise<boolean> => {
    if (profileId === undefined) {
      setBusy(true);
      setError(null);
      setInvalidField(null);
      setMessage(null);
    } else {
      setPendingProfiles((current) => ({ ...current, [profileId]: true }));
      setProfileErrors(({ [profileId]: _stale, ...rest }) => rest);
    }
    try {
      await operation();
      return true;
    } catch (caught) {
      const text = caught instanceof Error ? caught.message : String(caught);
      if (profileId === undefined) setError(text);
      else setProfileErrors((current) => ({ ...current, [profileId]: text }));
      return false;
    } finally {
      if (profileId === undefined) setBusy(false);
      else setPendingProfiles(({ [profileId]: _finished, ...rest }) => rest);
    }
  };
  const saveSwitches = (profile: RedactedModelProviderProfile): Promise<boolean> => run(async () => {
    const saved = await api.saveModelProviderProfile({ profile });
    profileUpdates.current.set(profile.profileId, saved);
    setProfiles((current) => current?.map((value) => value.profileId === profile.profileId ? saved : value) ?? null);
  }, profile.profileId);
  // A test run before a change says nothing about the backend as it is now.
  const forgetTest = (profileId: string): void =>
    setTestResults(({ [profileId]: _stale, ...rest }) => rest);

  // Priorities are unique across every profile, judges included.
  const nextPriority = (): number =>
    allProfiles.length === 0 ? 0 : Math.max(...allProfiles.map((profile) => profile.priority)) + 10;

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
      nextPriority();
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
    if (orderingBlocked) return Promise.resolve();
    // Each list is ordered within itself: a backend let go over a judge, or a judge over a backend, stays put.
    const judging = isJudge(sourceProfileId);
    const currentOrder = (judging ? judgeProfiles : profileValues).map((profile) => profile.profileId);
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
      // The judges keep their place after the backends: the repository takes every profile's place at once.
      const others = (judging ? profileValues : judgeProfiles).map((profile) => profile.profileId);
      await api.reorderModelProviderProfiles(judging ? [...others, ...order] : [...order, ...others]);
      await load();
    });
  };

  const moveWithKeyboard = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
    list = profileValues,
  ): void => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
      return;
    }
    event.preventDefault();
    const offset = event.key === "ArrowUp" ? -1 : 1;
    const target = list[index + offset];
    const source = list[index];
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
    // Not a place to drop it: the row being dragged belongs to the other list.
    if (draggedProfileId !== null && isJudge(draggedProfileId) !== isJudge(profileId)) return;
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

  const saveJudgeEditor = async (): Promise<void> => {
    if (judgeEditor === null) return;
    if (judgeEditor.label.trim().length === 0) { refuse("judgeLabel", "请输入名称。"); return; }
    const endpoint = judgeEditor.endpoint.trim();
    // The whole endpoint, without a query or fragment: a key could ride in one into the call records.
    if (!secureEndpoint(endpoint) || /[?#]/u.test(endpoint)) { refuse("judgeEndpoint", "接口地址必须使用 HTTPS（本机回环地址可用 HTTP），不含账号密码、查询参数或片段。"); return; }
    if (!/^~?[A-Za-z0-9._:-]+(?:\/[A-Za-z0-9._:-]+)*$/u.test(judgeEditor.model.trim())) { refuse("judgeModel", "请填写模型名，例如 typesafe/jev-1.14 或 gpt-6-luna。"); return; }
    const timeoutMs = Number(judgeEditor.timeoutMs);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) { refuse("judgeTimeout", "超时时间必须在 1000 到 120000 毫秒之间。"); return; }
    if (judgeEditor.existing === null && judgeEditor.secret.trim().length === 0) { refuse("judgeSecret", "请输入 API 密钥。"); return; }
    const proxy = proxyInput(judgeEditor);
    if (!proxy.success) { refuse("judgeProxyUrl", "请填写有效的 HTTP/HTTPS 代理地址，不包含账号密码、路径或查询参数。"); return; }
    const profile: RedactedModelProviderProfile = {
      version: 1,
      profileId: judgeEditor.existing?.profileId ?? nextProfileId(),
      kind: JUDGE_KIND,
      label: judgeEditor.label.trim(),
      enabled: judgeEditor.existing?.enabled ?? true,
      priority: judgeEditor.existing?.priority ?? nextPriority(),
      model: judgeEditor.model.trim(),
      timeoutMs,
      proxy: proxy.data,
      // OpenRouter's address and the System One shape are what a judge has when it sets neither: left unset, as before.
      ...(endpoint === OPENROUTER_DECISIONS_URL ? {} : { baseUrl: endpoint }),
      ...(judgeEditor.protocol === "systemone" ? {} : { decisionsProtocol: judgeEditor.protocol }),
      ...(judgeEditor.existing?.fallbackOnFailure === undefined ? {} : { fallbackOnFailure: judgeEditor.existing.fallbackOnFailure }),
      credentialConfigured: judgeEditor.existing?.credentialConfigured ?? false,
    };
    let saved = false;
    await run(async () => {
      await api.saveModelProviderProfile({ profile, ...(judgeEditor.secret.length === 0 ? {} : { secret: judgeEditor.secret }) });
      saved = true;
      forgetTest(profile.profileId);
      setMessage("判定模型已保存。");
      await load();
    });
    if (saved) setJudgeEditor(null);
  };

  const testProfile = async (profileId: string): Promise<void> => {
    setTestingProfiles((current) => ({ ...current, [profileId]: true }));
    forgetTest(profileId);
    setTestErrors(({ [profileId]: _stale, ...rest }) => rest);
    try {
      const result = await api.testModelProviderProfile(profileId);
      setTestResults((current) => ({ ...current, [profileId]: result }));
    } catch (caught) {
      setTestErrors((current) => ({ ...current, [profileId]: caught instanceof Error ? caught.message : String(caught) }));
    } finally {
      setTestingProfiles(({ [profileId]: _finished, ...rest }) => rest);
    }
  };

  const testButton = (profile: RedactedModelProviderProfile) => (
    <IconButton
      type="button"

      disabled={pendingProfiles[profile.profileId] || testingProfiles[profile.profileId]}
      aria-busy={testingProfiles[profile.profileId] || undefined}
      aria-label={`测试 ${profile.label}`}
      onClick={(event) =>
        keepSwitchFocus(event.currentTarget, testProfile(profile.profileId))
      }
    >
      <ActionIcon name="test" />
    </IconButton>
  );

  const deleteButton = (profile: RedactedModelProviderProfile) => (
    <IconButton
      type="button"
      className="danger-text"
      data-delete-for={profile.profileId}
      disabled={rowBusy(profile.profileId) || testingProfiles[profile.profileId]}
      aria-label={`删除 ${profile.label}`}
      aria-expanded={deleteTarget === profile.profileId}
      onBlur={(event) => {
        if (deleteTarget === profile.profileId && !keepsDeleteArmed(event.relatedTarget, profile.profileId)) setDeleteTarget(null);
      }}
      // Asks under the row; a double-click lands both clicks here, never on the question's 删除.
      onClick={() => setDeleteTarget(profile.profileId)}
    >
      <ActionIcon name="trash" />
    </IconButton>
  );

  /** What a row shows under itself: its last test, and the question before its deletion. */
  const rowFooter = (profile: RedactedModelProviderProfile) => {
    const testResult = testResults[profile.profileId];
    return <>
      {profileErrors[profile.profileId] === undefined ? null : (
        <div className="provider-test-result provider-test-failed" role="alert"><span className="provider-test-summary">操作失败 · {profileErrors[profile.profileId]}</span></div>
      )}
      {testingProfiles[profile.profileId] ? (
        <div className="provider-test-result" role="status" aria-label={`${profile.label} 测试中`}><span className="provider-test-summary">正在测试…</span></div>
      ) : null}
      {testErrors[profile.profileId] === undefined ? null : (
        <div className="provider-test-result provider-test-failed" role="alert"><span className="provider-test-summary">测试失败 · {testErrors[profile.profileId]}</span></div>
      )}
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
          <ActionIcon name={testResult.ok ? "check" : "close"} />
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
      {deleteTarget === profile.profileId ? (
        <div
          className="provider-delete-confirm"
          role="group"
          aria-label={`确认删除 ${profile.label}`}
          data-delete-for={profile.profileId}
          tabIndex={-1}
          onBlur={(event) => {
            if (!keepsDeleteArmed(event.relatedTarget, profile.profileId)) setDeleteTarget(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") disarmDelete(profile.profileId);
          }}
        >
          <span>删除「{profile.label}」和它保存在本机的 API 密钥？</span>
          <button type="button" className="secondary-button" disabled={rowBusy(profile.profileId)} onClick={() => disarmDelete(profile.profileId)}>取消</button>
          <button
            type="button"
            className="primary-button danger-button"
            aria-label={`确认删除 ${profile.label}`}
            disabled={rowBusy(profile.profileId) || testingProfiles[profile.profileId]}
            onClick={() => void run(async () => {
              await api.deleteModelProviderProfile(profile.profileId);
              profileUpdates.current.set(profile.profileId, null);
              setProfiles((current) => current?.filter((value) => value.profileId !== profile.profileId) ?? null);
              setDeleteTarget((current) => current === profile.profileId ? null : current);
            }, profile.profileId)}
          >
            删除
          </button>
        </div>
      ) : null}
    </>;
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
    <>
      <section className="settings-card global-model-proxy-card" aria-labelledby={fieldIds + "global-proxy-title"}>
        <header className="settings-card-header">
          <div><h2 id={fieldIds + "global-proxy-title"}>全局模型代理</h2></div>
        </header>
        <p className="settings-card-description">统一用于模型后端和判定模型的外部请求（含 Codex、Claude CLI），保存后立即生效。</p>
        <form className="global-model-proxy-form" aria-label="全局模型代理" onSubmit={event => { event.preventDefault(); void saveGlobalProxy(); }}>
          <div className="form-field">
            <label htmlFor={fieldIds + "global-proxy"}>全局模型代理地址</label>
            <div className="global-model-proxy-controls">
              <input id={fieldIds + "global-proxy"} ref={globalProxyInput} inputMode="url" autoComplete="off" maxLength={2000} placeholder="http://127.0.0.1:7890" value={globalProxy?.url ?? ""} disabled={globalProxy === null || globalProxySaving} aria-invalid={globalProxyError ? true : undefined} aria-describedby={[fieldIds + "global-proxy-help", globalProxyError ? fieldIds + "global-proxy-error" : ""].filter(Boolean).join(" ")} onChange={event => { setGlobalProxy(current => current === null ? current : { ...current, url: event.target.value }); setGlobalProxyError(null); setGlobalProxyMessage(null); }} />
              <button type="submit" className="secondary-button" disabled={globalProxy === null || globalProxySaving}>{globalProxySaving ? "正在保存…" : "保存全局代理"}</button>
            </div>
            <p id={fieldIds + "global-proxy-help"}>留空时使用各后端的单独代理；都未设置时禁止外部请求。代理地址不填写账号密码。</p>
            {globalProxy?.environmentOverride ? <p>启动环境已设置 MODEL_PROXY_URL，将优先使用该变量；这里保存的地址会在移除变量后生效。</p> : null}
            {globalProxyError ? <p className="form-field-error" id={fieldIds + "global-proxy-error"} role="alert">{globalProxyError}</p> : null}
            {globalProxyMessage ? <p className="settings-status" role="status">{globalProxyMessage}</p> : null}
          </div>
        </form>
      </section>
    <section
      className="settings-card model-provider-card"
      aria-labelledby="model-provider-title"
      role="region"
    >
      <header className="settings-card-header model-provider-header">
        <div>
          <h2 id="model-provider-title">模型后端</h2>
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
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4.5v11M4.5 10h11" /></svg>
          添加模型后端
        </button>
      </header>
      <p className="settings-card-description">
        按顺序尝试，拖动左侧把手调整顺序；关掉「失败后切换」，这个后端失败时就不再试下一个。
      </p>

      {profiles === null && profilesError !== null ? (
        <div className="load-failure" role="alert">
          <span>模型后端暂时无法读取：{profilesError}</span>
          <button type="button" className="secondary-button" onClick={() => readProfiles()}>
            重试
          </button>
        </div>
      ) : profiles === null ? (
        <div
          className="model-provider-list model-provider-loading"
          aria-live="polite"
        >
          <p className="empty-copy">正在读取模型后端…</p>
        </div>
      ) : profileValues.length === 0 ? (
        <div className="model-provider-list model-provider-loading">
          <p className="empty-copy">尚未配置模型后端。</p>
        </div>
      ) : (
        <>
        {/* What each column is, said once above the rows: every switch still carries its own name. */}
        <div className="provider-columns" aria-hidden="true">
          <span />
          <span>后端</span>
          <span>状态</span>
          <span>启用</span>
          <span>失败后切换</span>
          <span />
        </div>
        <ol className="model-provider-list">
          {profileValues.map((profile, index) => {
            const remote = remoteKinds.has(profile.kind);
            const localClient =
              profile.kind === "codex-cli" ||
              profile.kind === "claude-code-cli";
            const sendsRemote = remoteCallingKinds.has(profile.kind);
            const clientStatus = clientStatuses?.find(
              (status) => status.kind === profile.kind,
            );
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
                    draggable={!orderingBlocked}
                    disabled={orderingBlocked}
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
                    {/* The order the backends are tried in; the list already says it to a screen reader. */}
                    <span className="provider-order" aria-hidden="true">{index + 1}</span>
                    <strong title={profile.label}>{profile.label}</strong>
                    <span>
                      {kindLabel[profile.kind]}
                      {profile.model === undefined ? "" : ` · ${profile.model}`}
                      {remoteCallingKinds.has(profile.kind) ? ` · ${profile.proxy?.mode === "custom" ? "自定义代理" : profile.proxy?.mode === "direct" ? "仅 loopback 直连" : "全局模型代理"}` : ""}
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
                    <small>{clientStatus?.availability === "proxy_required" ? "请在配置中填写有效代理后重新检查" : statusDetail}</small>
                  </div>
                  {/* The main switch, named on screen by the column above it; failing over is a setting of an enabled backend. */}
                  <label className="provider-switch" title={`${profile.label} 启停`}>
                    <input
                      type="checkbox"
                      role="switch"
                      checked={profile.enabled}
                      disabled={rowBusy(profile.profileId)}
                      aria-busy={pendingProfiles[profile.profileId] || undefined}
                      aria-label={`启用 ${profile.label}`}
                      onChange={(event) => {
                        const enabled = event.currentTarget.checked;
                        keepSwitchFocus(event.currentTarget, saveSwitches({
                          ...profile,
                          enabled,
                          ...(clientStatus?.executablePath === undefined ? {} : { executablePath: clientStatus.executablePath }),
                        }));
                      }}
                    />
                  </label>
                  <label className="provider-fallback-control"><input type="checkbox" role="switch" aria-label={`${profile.label} 失败后切换`} checked={profile.fallbackOnFailure !== false} disabled={rowBusy(profile.profileId) || !profile.enabled} aria-busy={pendingProfiles[profile.profileId] || undefined} onChange={(event) => { const fallbackOnFailure = event.currentTarget.checked; keepSwitchFocus(event.currentTarget, saveSwitches({ ...profile, fallbackOnFailure })); }} /></label>
                  <div className="provider-actions">
                    {testButton(profile)}
                    {profile.kind === "qwen" ? <IconButton type="button" aria-haspopup="dialog" aria-label={`配置 ${profile.label}`} disabled={rowBusy(profile.profileId) || testingProfiles[profile.profileId] || localEditor !== null} onClick={() => setLocalEditor(profile)}><ActionIcon name="settings" /></IconButton> : null}
                    {localClient ? (
                      <IconButton
                        type="button"

                        aria-haspopup="dialog"
                        disabled={rowBusy(profile.profileId) || testingProfiles[profile.profileId] || editor !== null || cliEditor !== null}
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
                          disabled={rowBusy(profile.profileId) || testingProfiles[profile.profileId] || editor !== null}
                          aria-label={`编辑 ${profile.label}`}
                          onClick={() => {
                            openEditor(editorFor(profile));
                            setError(null);
                            setMessage(null);
                          }}
                        >
                          <ActionIcon name="edit" />
                        </IconButton>
                        {deleteButton(profile)}
                      </>
                    ) : null}
                  </div>
                </div>
                {rowFooter(profile)}
              </li>
            );
          })}
        </ol>
        </>
      )}

      {profiles === null ? null : (
        <section className="judge-provider-section" aria-labelledby="judge-provider-title">
          <header className="settings-card-header model-provider-header">
            <div>
              <h3 id="judge-provider-title">判定模型（不参与生成）</h3>
              <IconButton aria-label="判定模型使用说明" title="仅主动调用，不参与识别、问答或 PR 评审。失败后切换可关闭。调用内容保留90天，可在日志查看。仅 OpenRouter 的 System One 请求要求禁用留存，其他情况按服务政策处理。"><ActionIcon name="help" /></IconButton>
            </div>
            <button type="button" className="secondary-button model-provider-add-button" aria-haspopup="dialog" disabled={busy || judgeEditor !== null} onClick={() => openJudgeEditor(judgeEditorFor())}>
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4.5v11M4.5 10h11" /></svg>
              添加判定模型
            </button>
          </header>
          <p className="settings-card-description">
            可选，仅用于判断与评分，按本组顺序调用。
          </p>
          {judgeProfiles.length === 0 ? (
            <div className="model-provider-list model-provider-loading">
              <p className="empty-copy">未添加（可选）</p>
            </div>
          ) : (
            <>
            <div className="provider-columns" aria-hidden="true">
              <span />
              <span>判定模型</span>
              <span>状态</span>
              <span>启用</span>
              <span>失败后切换</span>
              <span />
            </div>
            <ol className="model-provider-list">
              {judgeProfiles.map((profile, index) => (
                <li
                  key={profile.profileId}
                  className={`provider-item${draggedProfileId === profile.profileId ? " dragging" : ""}${dropTarget?.profileId !== profile.profileId ? "" : dropTarget.edge === "before" ? " drop-before" : " drop-after"}`}
                  onDragOver={(event) => dragOver(event, profile.profileId)}
                  onDrop={(event) => drop(event, profile.profileId)}
                >
                  <div className="provider-row" data-disabled={profile.enabled ? undefined : true}>
                    <IconButton
                      type="button"
                      className="provider-drag-handle"
                      draggable={!orderingBlocked}
                      disabled={orderingBlocked}
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
                      onKeyDown={(event) => moveWithKeyboard(event, index, judgeProfiles)}
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
                      <span className="provider-order" aria-hidden="true">{index + 1}</span>
                      <strong title={profile.label}>{profile.label}</strong>
                      <span>
                        {new URL(profile.baseUrl ?? OPENROUTER_DECISIONS_URL).host} · {profile.model} · {profile.proxy?.mode === "custom" ? "自定义代理" : profile.proxy?.mode === "direct" ? "仅 loopback 直连" : "全局模型代理"}
                      </span>
                      {usage.get(profile.profileId) === undefined ? null : (
                        <small className="provider-usage">
                          调用记录：{usageLabel(usage.get(profile.profileId)!)}
                        </small>
                      )}
                    </div>
                    <div className="provider-status-cell">
                      <span className={profile.credentialConfigured ? "provider-status-healthy" : "provider-status-attention"}>
                        {profile.credentialConfigured ? "凭据已配置" : "尚未配置凭据"}
                      </span>
                      <small>远程调用</small>
                    </div>
                    <label className="provider-switch" title={`${profile.label} 启停`}>
                      <input
                        type="checkbox"
                        role="switch"
                        checked={profile.enabled}
                        disabled={rowBusy(profile.profileId)}
                        aria-busy={pendingProfiles[profile.profileId] || undefined}
                        aria-label={`启用 ${profile.label}`}
                        onChange={(event) => {
                          const enabled = event.currentTarget.checked;
                          keepSwitchFocus(event.currentTarget, saveSwitches({ ...profile, enabled }));
                        }}
                      />
                    </label>
                    <label className="provider-fallback-control"><input type="checkbox" role="switch" aria-label={`${profile.label} 失败后切换`} checked={profile.fallbackOnFailure !== false} disabled={rowBusy(profile.profileId) || !profile.enabled} aria-busy={pendingProfiles[profile.profileId] || undefined} onChange={(event) => { const fallbackOnFailure = event.currentTarget.checked; keepSwitchFocus(event.currentTarget, saveSwitches({ ...profile, fallbackOnFailure })); }} /></label>
                    <div className="provider-actions">
                      {testButton(profile)}
                      <IconButton type="button" aria-haspopup="dialog" disabled={rowBusy(profile.profileId) || testingProfiles[profile.profileId] || judgeEditor !== null} aria-label={`编辑 ${profile.label}`} onClick={() => openJudgeEditor(judgeEditorFor(profile))}>
                        <ActionIcon name="edit" />
                      </IconButton>
                      {deleteButton(profile)}
                    </div>
                  </div>
                  {rowFooter(profile)}
                </li>
              ))}
            </ol>
            </>
          )}
        </section>
      )}

      {judgeEditor === null ? null : (() => {
        const close = () => { setJudgeEditor(null); setError(null); };
        // Moved to another site (a preset, a relay), the saved key is not sent there: said before the save is refused.
        const judgeSecretHint = judgeEditor.existing?.credentialConfigured !== true ? null
          : siteOf(judgeEditor.endpoint) !== null && siteOf(judgeEditor.endpoint) !== siteOf(judgeEditor.existing.baseUrl ?? OPENROUTER_DECISIONS_URL)
            ? "地址换到了另一个站点，需要填写这个站点的 API 密钥" : "已安全保存，留空则不更换";
        return <ModalDialog
          title={judgeEditor.existing === null ? "添加判定模型" : `编辑 ${judgeEditor.existing.label}`}
          description="密钥仅保存在本机，存储方式遵循「通用」中的密钥设置"
          dismissible={!busy}
          unsaved={JSON.stringify(judgeEditor) !== JSON.stringify(judgeEditorOpenedWith)}
          onClose={close}
          footer={<>
            <button type="button" className="secondary-button" disabled={busy} onClick={close}>取消</button>
            <button type="submit" form="model-provider-judge-editor" className="primary-button" disabled={busy}>保存</button>
          </>}
        >
          <form className="form-fields provider-form" id="model-provider-judge-editor" aria-label={judgeEditor.existing === null ? "添加判定模型表单" : `编辑 ${judgeEditor.existing.label}`} onSubmit={(event) => { event.preventDefault(); void saveJudgeEditor(); }}>
            <fieldset className="form-fields" disabled={busy}>
              <div className="form-fields-row">
                {formField("judgeLabel", "显示名称", <input {...fieldProps("judgeLabel")} autoFocus value={judgeEditor.label} onChange={(event) => setJudgeEditor({ ...judgeEditor, label: event.currentTarget.value })} />)}
                {formField("judgeTimeout", "超时（毫秒）", <input {...fieldProps("judgeTimeout")} inputMode="numeric" value={judgeEditor.timeoutMs} onChange={(event) => setJudgeEditor({ ...judgeEditor, timeoutMs: event.currentTarget.value })} />)}
              </div>
              <div className="provider-presets" role="group" aria-labelledby={`${fieldIds}judge-presets`}>
                <span id={`${fieldIds}judge-presets`}>服务预设</span>
                {JUDGE_PRESETS.map((preset) => (
                  <button key={preset.label} type="button" className="secondary-button" onClick={() => setJudgeEditor({
                    ...judgeEditor, label: preset.label, endpoint: preset.endpoint, protocol: preset.protocol, model: preset.model,
                    secret: keyFor(judgeEditor.secret, judgeEditor.endpoint, preset.endpoint),
                  })}>{preset.label}</button>
                ))}
              </div>
              {formField("judgeEndpoint", "接口地址", <input {...fieldProps("judgeEndpoint", true)} value={judgeEditor.endpoint} onChange={(event) => setJudgeEditor({ ...judgeEditor, endpoint: event.currentTarget.value, secret: keyFor(judgeEditor.secret, judgeEditor.endpoint, event.currentTarget.value) })} />,
                "完整地址，包含路径，例如 https://openrouter.ai/api/alpha/decisions、https://api.openai.com/v1/decisions。只有用 System One 协议发往 OpenRouter 时，才会要求服务商不留存数据。")}
              <div className="form-fields-row">
                <div className="form-field">
                  <label htmlFor={`${fieldIds}judge-protocol`}>API 协议</label>
                  <select id={`${fieldIds}judge-protocol`} value={judgeEditor.protocol} onChange={(event) => setJudgeEditor({ ...judgeEditor, protocol: event.currentTarget.value as JudgeEditorState["protocol"] })}>
                    <option value="systemone">System One（OpenRouter、TypeSafe、Fireworks 等）</option>
                    <option value="openai">OpenAI Decisions</option>
                  </select>
                </div>
              </div>
              {formField("judgeModel", "模型", <input {...fieldProps("judgeModel", true)} value={judgeEditor.model} onChange={(event) => setJudgeEditor({ ...judgeEditor, model: event.currentTarget.value })} />,
                "这个服务上的决策模型名，例如 OpenRouter 的 typesafe/jev-1.14、openai/gpt-6-luna-decisions，OpenAI 的 gpt-6-luna；~typesafe/jev-latest 跟随最新版本。")}
              {formField("judgeSecret", "API 密钥", <input {...fieldProps("judgeSecret", judgeSecretHint !== null)} type="password" autoComplete="new-password" value={judgeEditor.secret} onChange={(event) => setJudgeEditor({ ...judgeEditor, secret: event.currentTarget.value })} />,
                judgeSecretHint)}
              <hr className="form-fields-divider" />
              <ProxyFields id={`${fieldIds}judge-`} value={judgeEditor} onChange={(proxy) => setJudgeEditor({ ...judgeEditor, ...proxy })} urlProps={fieldProps("judgeProxyUrl")} urlError={fieldError("judgeProxyUrl")} />
            </fieldset>
            {formError}
          </form>
        </ModalDialog>;
      })()}

      {localEditor === null ? null : <LocalQwenModelDialog api={api} profile={localEditor} onClose={() => setLocalEditor(null)} onSaved={load} />}
      {cliEditor === null ? null : (() => {
        const close = () => { setCliEditor(null); setError(null); };
        const source = clientStatuses?.find(status => status.kind === cliEditor.profile.kind)?.modelsSource;
        return <ModalDialog
          title={`配置 ${cliEditor.profile.label}`}
          description="使用客户端现有登录状态"
          dismissible={!busy}
          unsaved={JSON.stringify(cliEditor) !== JSON.stringify(cliEditorOpenedWith)}
          onClose={close}
          footer={<>
            <button type="button" className="secondary-button" disabled={busy} onClick={close}>取消</button>
            <button type="submit" form="model-provider-cli-editor" className="primary-button" disabled={busy}>保存客户端</button>
          </>}
        >
          <form className="form-fields provider-form" id="model-provider-cli-editor" aria-label={`配置 ${cliEditor.profile.label}`} onSubmit={(event) => { event.preventDefault(); void saveCliEditor(); }}>
            <fieldset className="form-fields" disabled={busy}>
              {formField("cliPath", "客户端路径",
                <input {...fieldProps("cliPath", true)} autoFocus value={cliEditor.executablePath} onChange={(event) => setCliEditor({ ...cliEditor, executablePath: event.currentTarget.value })} />,
                `内容经本机客户端发送给 ${cliEditor.profile.kind === "codex-cli" ? "OpenAI" : "Anthropic"} 的模型服务，可能消耗额度；不会修改、退出或复制客户端账户。`)}
              <div className="form-fields-row">
                {/* The candidates are the field's own: read again beside it, not from among the dialog's closing buttons. */}
                {formField("cliModel", "客户端模型",
                  <div className="provider-model-control">
                    <input {...fieldProps("cliModel", true)} value={cliEditor.model} onChange={(event) => setCliEditor({ ...cliEditor, model: event.currentTarget.value })} />
                    <ModelCandidates models={clientStatuses?.find(status => status.kind === cliEditor.profile.kind)?.models ?? []} value={cliEditor.model} onPick={(model) => setCliEditor({ ...cliEditor, model })} />
                    <IconButton type="button" aria-label="刷新模型候选" onClick={() => void run(load)}><ActionIcon name="refresh" /></IconButton>
                  </div>,
                  `可选择候选或手动输入；留空使用客户端默认模型。${source === "server" ? "候选来源：服务端直查。" : source === "client" ? "候选来源：CLI 目录（可能使用客户端内部缓存）。" : source === "cache" ? "候选来源：本机缓存（服务端及 CLI 查询未成功）。" : "尚无模型候选；刷新时依次尝试服务端、CLI 目录和本机缓存。"}`)}
                {formField("cliTimeout", "超时（毫秒）",
                  <input {...fieldProps("cliTimeout")} inputMode="numeric" value={cliEditor.timeoutMs} onChange={(event) => setCliEditor({ ...cliEditor, timeoutMs: event.currentTarget.value })} />)}
              </div>
              <hr className="form-fields-divider" />
              <ProxyFields allowLoopback={false} id={fieldIds} value={cliEditor} onChange={(proxy) => setCliEditor({ ...cliEditor, ...proxy })} urlProps={fieldProps("cliProxyUrl")} urlError={fieldError("cliProxyUrl")} />
            </fieldset>
            {formError}
          </form>
        </ModalDialog>;
      })()}

      {editor === null ? null : (() => {
        const close = () => { setEditor(null); setError(null); };
        const compatible = editor.kind === "openai-compatible";
        const peak = editor.pricingMode === "deepseek";
        // Moved to another site (a preset, a relay), the saved key is not sent there: said before the save is refused.
        const secretHint = !editor.existing?.credentialConfigured ? null
          : siteOf(editor.baseUrl) !== null && siteOf(editor.baseUrl) !== siteOf(editor.existing.baseUrl)
            ? "地址换到了另一个站点，需要填写这个站点的 API 密钥" : "已安全保存，留空则不更换";
        const price = (field: "inputPrice" | "outputPrice" | "cachedInputPrice" | "peakInputPrice" | "peakOutputPrice" | "peakCachedInputPrice", label: string, placeholder?: string) =>
          formField(field, label, <input {...fieldProps(field)} inputMode="decimal" placeholder={placeholder} value={editor[field]} onChange={(event) => setEditor({ ...editor, [field]: event.currentTarget.value })} />);
        return <ModalDialog
          title={editor.existing === null ? "添加模型后端" : `编辑 ${editor.existing.label}`}
          description="密钥仅保存在本机，存储方式遵循「通用」中的密钥设置"
          dismissible={!busy}
          unsaved={JSON.stringify(editor) !== JSON.stringify(editorOpenedWith)}
          onClose={close}
          footer={<>
            <button type="button" className="secondary-button" disabled={busy} onClick={close}>取消</button>
            <button type="submit" form="model-provider-editor" className="primary-button" disabled={busy}>保存后端</button>
          </>}
        >
          <form className="form-fields provider-form" id="model-provider-editor" aria-label={editor.existing === null ? "添加模型后端表单" : `编辑 ${editor.existing.label}`} onSubmit={(event) => { event.preventDefault(); void saveEditor(); }}>
            <fieldset className="form-fields" disabled={busy}>
              <div className="form-fields-row">
                <div className="form-field">
                  <label htmlFor={`${fieldIds}kind`}>后端类型</label>
                  <select id={`${fieldIds}kind`} autoFocus={editor.existing === null} value={editor.kind} disabled={editor.existing !== null}
                    onChange={(event) => {
                      const kind = event.currentTarget.value as RemoteKind;
                      setEditor((current) => current === null ? current : { ...current, kind, ...defaultsFor(kind), secret: keyFor(current.secret, current.baseUrl, defaultsFor(kind).baseUrl) });
                    }}>
                    <option value="openai">OpenAI</option>
                    <option value="anthropic">Anthropic</option>
                    <option value="openai-compatible">OpenAI 兼容</option>
                  </select>
                </div>
                {formField("label", "显示名称", <input {...fieldProps("label")} autoFocus={editor.existing !== null} value={editor.label} onChange={(event) => setEditor({ ...editor, label: event.currentTarget.value })} />)}
              </div>
              {/* Filling these by hand is error-prone (DeepSeek only takes json_object): a row of its own under the type. */}
              {compatible ? <div className="provider-presets" role="group" aria-labelledby={`${fieldIds}presets`}>
                <span id={`${fieldIds}presets`}>服务预设</span>
                {COMPATIBLE_PRESETS.map((preset) => (
                  <button key={preset.id} type="button" className="secondary-button" onClick={() => setEditor({
                    ...editor, label: preset.label, baseUrl: preset.baseUrl, apiProtocol: preset.apiProtocol, jsonMode: preset.jsonMode,
                    secret: keyFor(editor.secret, editor.baseUrl, preset.baseUrl),
                    model: editor.model.trim().length === 0 ? preset.models[0] : editor.model,
                  })}>{preset.label}</button>
                ))}
              </div> : null}
              {formField("baseUrl", "服务地址", <input {...fieldProps("baseUrl", true)} value={editor.baseUrl} onChange={(event) => setEditor({ ...editor, baseUrl: event.currentTarget.value, secret: keyFor(editor.secret, editor.baseUrl, event.currentTarget.value) })} />,
                "此后端会收到语义识别所需的裁剪问答。")}
              <div className="form-fields-row">
                {formField("model", "模型", <div className="provider-model-control">
                  <input {...fieldProps("model")} value={editor.model} onChange={(event) => setEditor({ ...editor, model: event.currentTarget.value })} />
                  {/* The presets' models: an OpenAI or Anthropic backend was offered DeepSeek's. */}
                  {compatible ? <ModelCandidates models={COMPATIBLE_PRESETS.flatMap((preset) => preset.models.map((id) => ({ id })))} value={editor.model} onPick={(model) => setEditor({ ...editor, model })} /> : null}
                </div>)}
                {formField("timeoutMs", "超时（毫秒）", <input {...fieldProps("timeoutMs")} inputMode="numeric" value={editor.timeoutMs} onChange={(event) => setEditor({ ...editor, timeoutMs: event.currentTarget.value })} />)}
              </div>
              {compatible ? <div className="form-fields-row">
                <div className="form-field">
                  <label htmlFor={`${fieldIds}protocol`}>API 协议</label>
                  <select id={`${fieldIds}protocol`} value={editor.apiProtocol} onChange={(event) => setEditor({ ...editor, apiProtocol: event.currentTarget.value as EditorState["apiProtocol"] })}>
                    <option value="responses">Responses</option>
                    <option value="chat-completions">Chat Completions</option>
                  </select>
                </div>
                <div className="form-field">
                  <label htmlFor={`${fieldIds}json-mode`}>JSON 输出</label>
                  <select id={`${fieldIds}json-mode`} value={editor.jsonMode} onChange={(event) => setEditor({ ...editor, jsonMode: event.currentTarget.value as EditorState["jsonMode"] })}>
                    <option value="schema">严格 Schema</option>
                    <option value="object">JSON 对象（DeepSeek 等）</option>
                  </select>
                </div>
              </div> : null}
              {formField("secret", "API 密钥", <input {...fieldProps("secret", secretHint !== null)} type="password" autoComplete="new-password" value={editor.secret} onChange={(event) => setEditor({ ...editor, secret: event.currentTarget.value })} />,
                secretHint)}
              <hr className="form-fields-divider" />
              <div className="form-fields" role="group" aria-labelledby={`${fieldIds}pricing`}>
                {/* The reference price is the group's: by its title, there only while the model it is for is the one set. */}
                <div className="provider-group-head">
                  <span id={`${fieldIds}pricing`}>计费单价（可选）</span>
                  {editor.model.trim() === "deepseek-flash" ? <button type="button" className="text-button" onClick={() => setEditor({ ...editor, pricingMode: "deepseek", currency: "¥", inputPrice: "1", cachedInputPrice: "0.02", outputPrice: "4", peakInputPrice: "2", peakCachedInputPrice: "0.04", peakOutputPrice: "8", holidayYear: "2026", holidays: DEEPSEEK_2026_HOLIDAYS.join("\n") })}>填入 DeepSeek Flash 参考价格</button> : null}
                </div>
                <div className="form-fields-row">
                  <div className="form-field">
                    <label htmlFor={`${fieldIds}pricing-mode`}>计费方式</label>
                    <select id={`${fieldIds}pricing-mode`} value={editor.pricingMode} onChange={(event) => setEditor({ ...editor, pricingMode: event.currentTarget.value === "deepseek" ? "deepseek" : "fixed" })}><option value="fixed">固定单价</option><option value="deepseek">DeepSeek 峰谷计费</option></select>
                  </div>
                  {formField("currency", "货币", <input {...fieldProps("currency")} maxLength={8} placeholder="¥" value={editor.currency} onChange={(event) => setEditor({ ...editor, currency: event.currentTarget.value })} />)}
                </div>
                {/* Three to a row, every label one line: their inputs line up (labels of one, two and three lines did not). */}
                {peak ? <>
                  <div className="provider-price-row">
                    {price("inputPrice", "空闲缓存未命中输入单价", "1.0")}
                    {price("outputPrice", "空闲输出单价", "2.0")}
                    {price("cachedInputPrice", "空闲缓存命中输入单价")}
                  </div>
                  <div className="provider-price-row">
                    {price("peakInputPrice", "高峰缓存未命中输入单价")}
                    {price("peakOutputPrice", "高峰输出单价")}
                    {price("peakCachedInputPrice", "高峰缓存命中输入单价")}
                  </div>
                  <div className="form-fields-row">
                    {formField("holidayYear", "节假日日历年份", <input {...fieldProps("holidayYear")} inputMode="numeric" value={editor.holidayYear} onChange={(event) => setEditor({ ...editor, holidayYear: event.currentTarget.value })} />)}
                    {formField("holidays", "全天按空闲价的节假日", <textarea {...fieldProps("holidays", true)} rows={3} value={editor.holidays} onChange={(event) => setEditor({ ...editor, holidays: event.currentTarget.value })} />,
                      "每行一个日期（YYYY-MM-DD）。")}
                  </div>
                  <p className="provider-group-note">北京时间周一至周五 09:00–12:00、14:00–18:00 为高峰。周末（含调休上班日）与已配置节假日全天为空闲。未覆盖年份或缓存用量缺失时显示估算范围。</p>
                </> : <div className="provider-price-row">
                  {price("inputPrice", "输入单价", "1.0")}
                  {price("outputPrice", "输出单价", "2.0")}
                  {price("cachedInputPrice", "缓存命中输入单价")}
                </div>}
                <p className="provider-group-note">按每百万 token 计；缓存命中单价可以不填。价格由你配置，参考价核对于 2026-10-12；新调用保留当时价格，旧记录按当前价格估算。费用以服务商账单为准。</p>
              </div>
              <hr className="form-fields-divider" />
              <ProxyFields id={fieldIds} value={editor} onChange={(proxy) => setEditor({ ...editor, ...proxy })} urlProps={fieldProps("proxyUrl")} urlError={fieldError("proxyUrl")} />
            </fieldset>
            {formError}
          </form>
        </ModalDialog>;
      })()}

      {error === null || editor !== null || cliEditor !== null || judgeEditor !== null ? null : (
        <p className="settings-status error" role="alert">
          {error}
        </p>
      )}
      {message === null ? null : (
        <p className="settings-status" role="status">
          {message}
        </p>
      )}
    </section>
    </>
  );
};
