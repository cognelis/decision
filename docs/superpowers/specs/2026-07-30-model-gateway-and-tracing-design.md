# Decision 模型网关、调用追踪与客户端适配设计

日期：2026-07-30

状态：已实现

## 1. 背景

Decision 当前已经有一条本地语义判断链：

1. Hook 被动采集 Claude Code / Codex 已经发生的原生交互；
2. Desktop 将当前 assistant 文本和下一条 user 文本配对；
3. Apple Foundation Models 或 Qwen 对配对执行结构化分类；
4. 本地模型不可用时退回规则识别；
5. 高置信结果进入理由流程，中置信结果进入待处理队列。

现有 `capture-audit` 是刻意设计的无正文诊断收据。它只保存阶段、置信档位、耗时、错误码和
HMAC 指纹，不保存模型实际看到的文本，也不保存模型输出。这能定位“链路在哪一层失败”，
但不能回答以下问题：

- 模型实际收到的输入是什么；
- 模型原始输出和最终结构化结果是否一致；
- 一次判断消耗了多少输入、输出、缓存和推理 Token；
- 一次成功是由哪个模型、哪个提示词版本和哪次回退产生的；
- 本地模型、直接 LLM API、Codex CLI 和 Claude Code CLI 的效果、延迟与成本如何比较。

同时，当前模型提供者接口只支持 Apple 和 Qwen，设置页也只能显示最终选中的提供者状态，
不能配置直接 LLM API，不能把用户已经登录的 Codex / Claude Code 本地客户端作为判断后端，
也不能测试、排序或禁用单个后端。

本设计新增统一模型网关。网关负责结构化生成、调用追踪、Token 归一化、后端配置、超时、
回退与可用性诊断。当前先用于语义判断，接口保留给后续方法论、Skills 和工作流提炼复用。

## 2. 产品边界

### 2.1 目标

- 为 Decision 自己发起的每一次模型判断保存可审计调用追踪；
- 追踪至少包含实际发送的模型输入、可见原始输出、结构化输出、模型信息、耗时和 Token；
- 保留现有无正文 `capture-audit`，不把敏感正文混入原有诊断收据；
- 继续支持 Apple Foundation Models 和 Qwen；
- 支持 OpenAI Responses API、Anthropic Messages API 和 OpenAI-compatible API；
- 支持把本机已登录的 Codex CLI、Claude Code CLI 配置为可选判断后端；
- 在设置页检测、配置、测试、启停和排序所有后端；
- 后端失败、超时或输出无效时记录完整回退链，并继续尝试下一后端；
- 不改变 Claude Code、Codex 的原生交互和提问方式；
- 不让作为判断后端启动的 CLI 执行开发任务、写工作区或产生可恢复会话；
- 不把模型追踪写入 Obsidian 或 SQLite；
- API 密钥永不进入普通设置、日志、Markdown、SQLite 或子进程参数。

### 2.2 非目标

- 不记录 Claude Code 或 Codex 的全部原生会话；
- 不采集或保存模型隐藏思维过程；
- 不把 Codex / Claude Code 重新注册成问答 MCP；
- 不让 Decision 代理或替换 `AskUserQuestion` / `request_user_input`；
- 不让远程后端在未明确启用时静默接收上下文；
- 不在本阶段提供任意提示词游乐场或任意 shell 参数输入；
- 不把模型调用追踪变成新的决策事实来源；
- 不在当前阶段加入 DuckDB、跨记录统计或知识图谱。

## 3. 方案选择

采用“统一模型网关 + 提供者适配器 + 独立追踪中间件”。

不采用只接直接 API：

- 直接 API 的结构和 Token 数据最稳定，但需要额外密钥与按量费用；
- 无法复用用户已经登录的 Codex / Claude Code 订阅或企业配置；
- 不能比较本地模型与本地客户端的实际效果。

不采用只调用 CLI：

- CLI 启动成本和版本差异明显；
- CLI 输出中的 Token 字段可能不完整；
- CLI 本质仍是面向开发代理的入口，需要额外限制工具、会话和工作区访问；
- 用户可能只希望配置一个简单、低延迟的 API 后端。

统一模型网关把调用协议、追踪和路由从具体提供者中抽离。新增后端不再复制日志、超时、
校验和回退逻辑，也为后续方法论提炼保留同一条受控调用路径。

## 4. 总体架构

```text
SemanticDecisionCoordinator
          │
          ▼
StructuredModelGateway
  ├─ 构造受版本管理的 StructuredGenerationRequest
  ├─ 按启用顺序选择 ProviderProfile
  ├─ 对每次尝试执行 TraceMiddleware
  ├─ 校验结构化输出
  └─ 返回成功结果或统一失败
          │
          ├─ AppleFoundationAdapter
          ├─ QwenAdapter
          ├─ OpenAIResponsesAdapter
          ├─ AnthropicMessagesAdapter
          ├─ OpenAICompatibleAdapter
          ├─ CodexCliAdapter
          └─ ClaudeCodeCliAdapter

TraceMiddleware
  ├─ CaptureAuditStore      无正文、保留现有职责
  └─ ModelTraceStore        有正文、短期、本机私有、可删除

ProviderProfileRepository
  ├─ 非敏感配置             Application Support JSON
  └─ CredentialVault        Electron safeStorage / macOS Keychain
```

`SemanticDecisionCoordinator` 不再直接依赖某个本地分类器。它把语义分类提示词、输入和 JSON
Schema 交给 `StructuredModelGateway`，然后继续执行现有的原文定位校验和联合路由。模型仍不能
直接写队列、Markdown 或 SQLite。

## 5. 统一调用协议

### 5.1 请求

```ts
interface StructuredGenerationRequest {
  requestId: string;
  purpose:
    | "semantic-classification"
    | "provider-health-check"
    | "methodology-extraction"
    | "skill-drafting"
    | "workflow-drafting";
  promptVersion: string;
  schemaVersion: string;
  locale: "zh-CN" | "en";
  systemPrompt: string;
  userPrompt: string;
  outputSchema: JsonSchema;
  maxOutputTokens: number;
  correlation: {
    sourceClient?: "claude-code" | "codex";
    pairFingerprint?: string;
  };
}
```

当前业务只允许调用 `semantic-classification`；设置页的固定测试样本使用
`provider-health-check`。另外三个 `purpose` 是稳定的扩展点，不在本阶段暴露 UI 或业务入口。

网关记录的是 Decision 能控制并实际提交给适配器或远程 API 的输入。若提供者需要把
system/user prompt 合并、裁剪或增加协议包装，追踪必须保存最终提交版本，并另外保存原始
`promptVersion`，不能只记录调用网关前的理想输入。Codex / Claude Code 自己追加且不对调用方
公开的内置系统提示词属于不透明客户端实现，追踪必须明确标记为不可见，不能声称已经记录。

### 5.2 响应

```ts
interface StructuredGenerationResult<T> {
  requestId: string;
  attemptId: string;
  profileId: string;
  backend: ModelBackendKind;
  provider: string;
  model: string;
  providerVersion?: string;
  visibleOutput: string;
  parsedOutput: T;
  usage: NormalizedTokenUsage;
  timing: ModelTiming;
  providerRequestId?: string;
}
```

`visibleOutput` 是提供者返回给调用者的最终可见文本。CLI JSONL 中的内部 reasoning 事件、
隐藏思维内容、工具中间事件和认证材料不得作为原始输出保存。结构化结果必须再次通过应用侧
Schema、枚举、长度和原文包含校验。

### 5.3 Token 归一化

```ts
interface NormalizedTokenUsage {
  source: "provider_reported" | "runtime_measured" | "estimated" | "unavailable";
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}
```

约束：

- API 或 CLI 明确上报的数据标记为 `provider_reported`；
- Qwen 由所加载模型的 tokenizer / token meter 统计时标记为 `runtime_measured`；
- 只有使用与目标模型匹配的 tokenizer 才能标记为 `estimated`；
- Apple Foundation Models 未提供可靠 Token 计数时标记为 `unavailable`，不得用字符数伪装；
- 缺少单项时保持字段缺失，不填零；
- `totalTokens` 只有在提供者上报，或 input/output 均存在且语义明确时才计算；
- Token、成本和耗时都按单次 attempt 保存，调用组摘要只做求和，不覆盖原始值。

### 5.4 耗时

```ts
interface ModelTiming {
  queuedMs: number;
  providerMs: number;
  firstOutputMs?: number;
  totalMs: number;
}
```

不支持流式首输出的后端省略 `firstOutputMs`，不填零。

## 6. 模型调用追踪

### 6.1 与现有审计的关系

`capture-audit` 保持版本和内容边界不变，用于统计：

- Hook 是否收到事件；
- 文本是否解析、配对和落盘；
- 分类是否完成；
- 最终路由和稳定错误码。

新增 `model-traces` 只覆盖网关发起的模型调用。两者通过安装盐生成的相关指纹关联，不共享原始
会话 ID，也不互相嵌套正文。

### 6.2 数据结构

每个后端尝试单独保存一个 `ModelInvocationTrace`：

```ts
interface ModelInvocationTrace {
  version: 1;
  traceId: string;
  requestId: string;
  attemptId: string;
  attemptIndex: number;
  purpose: StructuredGenerationRequest["purpose"];
  correlationFingerprint?: string;
  profile: {
    profileId: string;
    backend: ModelBackendKind;
    provider: string;
    model: string;
    providerVersion?: string;
    promptVersion: string;
    schemaVersion: string;
  };
  input: {
    systemPrompt: string;
    userPrompt: string;
    outputSchema: JsonSchema;
  };
  output?: {
    visibleText: string;
    parsed: unknown;
  };
  usage: NormalizedTokenUsage;
  timing: ModelTiming;
  status:
    | "succeeded"
    | "timed_out"
    | "cancelled"
    | "auth_failed"
    | "unavailable"
    | "invalid_output"
    | "failed";
  errorCode?: ModelInvocationErrorCode;
  providerRequestId?: string;
  processExitCode?: number;
  diagnosticExcerpt?: string;
  createdAt: string;
  expiresAt: string;
}
```

`diagnosticExcerpt` 只允许保存经过凭据、Authorization header、常见密钥格式、用户主目录和
临时路径脱敏后的有限 stderr / HTTP 错误摘要，最长 2,000 字符。完整环境变量、请求 headers、
异常堆栈和 CLI JSONL 原流不得落盘。

### 6.3 存储

- 路径：`Application Support/Decision/model-traces`；
- 目录权限 `0700`，单文件权限 `0600`；
- 每条 trace 独立 JSON 文件，先写临时文件再原子改名；
- 默认保留 7 天，最多 1,000 条 attempt；
- 每次 list/append 时清理过期和溢出记录；
- 损坏文件移入权限相同的 quarantine，不影响后续调用；
- 支持按 trace 删除、按 request 删除、全部清空；
- 删除只影响诊断追踪，不影响候选、正式决策和 SQLite 索引；
- 不把追踪同步到 Obsidian、iCloud 或任何远程遥测。

模型输入输出追踪在本版本默认开启，因为这是本功能的直接目标。设置页明确显示“仅记录
Decision 发起的模型判断，默认 7 天后删除”，用户可以关闭新的正文追踪或立即清空。
关闭正文追踪后，仍保留现有无正文 `capture-audit`。

## 7. 提供者适配器

### 7.1 Apple Foundation Models

- 继续使用现有 Swift helper 和 stdin/stdout JSON Lines；
- helper 返回结构化结果、可见 JSON 文本、模型版本和运行耗时；
- 系统未提供可靠 Token API 时 `usage.source = "unavailable"`；
- 不为了补齐 Token 而引入不匹配的远程 tokenizer；
- helper 状态检查不产生正文追踪，实际 classify 产生追踪。

### 7.2 Qwen

- 继续使用固定校验的 GGUF 和 `node-llama-cpp`；
- 适配器返回实际构造的 system/user prompt、可见 JSON 和结构化结果；
- 使用模型自己的 tokenizer 或运行时 token meter 统计输入和生成 Token；
- 若当前运行库版本不能提供可靠计数，明确标记 `unavailable`，不按字符粗略伪造；
- 保持串行推理、超时、取消、会话历史重置和运行时恢复行为。

### 7.3 OpenAI Responses API

- 使用 `POST /v1/responses`；
- `store: false`；
- `tools: []`；
- 使用 Structured Outputs 约束语义分类 Schema；
- 解析 `usage.input_tokens`、`input_tokens_details.cached_tokens`、
  `output_tokens`、`output_tokens_details.reasoning_tokens` 和 `total_tokens`；
- 保存响应 ID，便于用户自行在供应商侧排查；
- v1 不执行适配器内部隐藏重试。一次真实 HTTP 请求就是一个 attempt，避免重复计费和日志
  含义不清；失败后由网关进入下一个 profile，后续版本若增加重试也必须为每次请求单独留痕。

### 7.4 Anthropic Messages API

- 使用 `POST /v1/messages`；
- 不启用工具；
- 使用供应商支持的结构化输出能力；不可用时要求仅返回 JSON 并执行严格应用侧校验；
- 解析提供者返回的 input、output、cache 和成本相关字段；不存在的字段保持缺失；
- 保存供应商请求 ID；
- 错误与重试约束和 OpenAI API 一致。

### 7.5 OpenAI-compatible API

- 用户配置 HTTPS base URL、模型名和凭据；
- 默认使用 Responses 兼容协议；可显式选择 Chat Completions 兼容协议；
- 只接受同源响应，不跟随跨域重定向；
- 只允许 HTTPS，`localhost` / `127.0.0.1` / `::1` 可显式使用 HTTP；
- 响应正文设置严格大小上限；
- Token 字段通过兼容映射解析，无法确认语义时保持 `unavailable`；
- 不假设第三方兼容端点支持 OpenAI 的数据保留或安全承诺，设置页必须明确标注。

### 7.6 Codex CLI

启动前检测：

- 配置的可执行文件存在且为普通文件；
- `codex --version` 能在短超时内返回；
- `codex doctor` 或等价只读能力能确认运行环境；诊断失败不修改配置；
- 实际版本是否支持 `exec`、`--ephemeral`、`--json` 和 `--output-schema`。

判断调用使用固定参数模板，不允许用户输入任意额外参数：

```text
codex exec
  --ephemeral
  --json
  --ignore-user-config
  --output-schema <temporary-schema>
  --sandbox read-only
  --ask-for-approval never
  --skip-git-repo-check
  --cd <empty-temporary-directory>
  -c features.shell_tool=false
  -c tools.web_search=false
  -c apps._default.enabled=false
  -c agents.enabled=false
  -c memories.generate_memories=false
  [--model <configured-model>]
  -
```

适配器还必须：

- 使用 stdin 传入提示词，避免正文出现在进程列表；
- 使用临时空目录，不把真实工作仓库交给子进程；
- 忽略普通用户配置，只复用 `CODEX_HOME` 中的认证；模型必须通过受校验的 `--model` 显式传入；
- 关闭 shell、web search、apps、multi-agent 和 memory generation；
- 不使用 `--dangerously-bypass-approvals-and-sandbox`；
- 使用 `--ephemeral`，不产生可恢复会话；
- 解析 JSONL 中最终可见消息、完成状态和 Token；忽略 reasoning 和工具中间事件；
- 设置 `DECISION_PROVIDER_CHILD=1`；
- Bridge 看到该标记时立即退出，避免子调用被 Decision 自己再次捕获形成递归；
- 达到超时先请求优雅退出，再终止子进程组；
- 临时 Schema 和空目录在调用结束后删除。

Codex CLI 默认禁用。启用前必须通过一次不含真实业务文本的结构化测试。

### 7.7 Claude Code CLI

启动前检测：

- 配置的可执行文件存在且为普通文件；
- `claude --version` 能在短超时内返回；
- `claude auth status` 返回已登录状态；
- 实际版本支持 `-p`、`--output-format json`、`--json-schema`、
  `--no-session-persistence`、`--safe-mode` 和 `--tools ""`。

判断调用使用固定参数模板：

```text
claude
  -p
  --safe-mode
  --tools ""
  --disallowedTools "mcp__*"
  --no-session-persistence
  --permission-mode dontAsk
  --output-format json
  --json-schema <inline-schema>
  [--model <configured-model>]
```

适配器还必须：

- 使用 stdin 传入提示词；
- `--safe-mode` 禁用 Hooks、Skills、Plugins、MCP、CLAUDE.md 和自动记忆；
- 显式禁用全部内置工具和 MCP 工具；
- 不使用 `--bare`，因为 bare 模式不会读取 OAuth / Keychain；
- 不恢复或继续任何现有会话；
- 解析最终 result、structured output、usage、cost、duration 和错误；
- 设置 `DECISION_PROVIDER_CHILD=1` 作为额外递归保护；
- 使用和 Codex 相同的进程、超时、大小与临时目录约束。

Claude Code CLI 默认禁用。启用前必须通过一次不含真实业务文本的结构化测试。

## 8. 配置与凭据

### 8.1 Provider Profile

```ts
interface ModelProviderProfile {
  version: 1;
  profileId: string;
  kind:
    | "apple"
    | "qwen"
    | "openai"
    | "anthropic"
    | "openai-compatible"
    | "codex-cli"
    | "claude-code-cli";
  label: string;
  enabled: boolean;
  priority: number;
  model?: string;
  timeoutMs: number;
  executablePath?: string;
  baseUrl?: string;
  apiProtocol?: "responses" | "chat-completions" | "messages";
  credentialRef?: string;
}
```

- Apple、Qwen 是不可删除的内置 profile；
- Codex、Claude Code 首次打开设置时自动发现，但保持禁用；
- API profile 由用户新增，可以删除；
- 超时范围为 1–120 秒；
- CLI 可执行路径和 API base URL 必须先规范化、验证后保存；
- 不提供任意参数字符串，避免把设置页变成 shell 注入入口；
- profile JSON 权限为 `0600`，但其中永远没有密钥。

### 8.2 凭据

- macOS 使用 Electron `safeStorage.encryptString` 加密后写入独立凭据文件；
- 密文文件权限 `0600`，只通过不可猜测的 `credentialRef` 与 profile 关联；
- `safeStorage` 不可用时不允许持久化明文密钥，只允许当前进程临时使用环境变量；
- Renderer 永远拿不到完整密钥，保存后只显示“已配置”；
- 更新和删除 profile 时同步更新对应凭据；
- 日志脱敏器必须覆盖 Authorization、X-Api-Key、Bearer、常见 `sk-` 前缀和用户配置的实际
  密钥值；
- 子进程只继承最小环境白名单。凭据由客户端自己的 Keychain / 配置读取，不由 Decision
  Island 复制。

## 9. 路由与回退

默认升级后保持当前行为：

```text
Apple → Qwen → 规则识别
```

Codex CLI、Claude Code CLI 和所有 API profile 初始禁用。用户启用并测试后，它们进入可排序
列表。网关只在一个 profile 返回以下稳定结果时尝试下一项：

- unavailable；
- timeout；
- transient network failure；
- non-zero CLI exit；
- invalid structured output；
- provider runtime failure。

以下情况停止该 profile 的自动重试，但仍允许路由到下一 profile：

- auth failed；
- quota exceeded；
- unsupported model；
- invalid configuration。

每个 attempt 都保存自己的追踪。最终成功 trace 不覆盖之前失败 trace。调用组摘要显示：

- 依次尝试了哪些后端；
- 每次为什么失败；
- 最终使用哪个后端；
- 总耗时与可求和 Token；
- 是否最终回退到纯规则。

远程后端一旦启用，即表示用户允许将当前裁剪后的决策问答发送给相应供应商；不扩大为完整
transcript。关闭或删除远程 profile 后立即停止新调用。

## 10. 设置页与追踪查看

设置页新增“模型后端”卡片：

- 显示当前实际后端和默认路由顺序；
- 每个 profile 显示类型、模型、版本、状态、最近一次测试时间；
- 支持启用/禁用、排序、测试、编辑和删除 API profile；
- Codex / Claude Code 显示自动发现路径、版本、登录状态和测试按钮；
- API 显示协议、base URL、模型和“密钥已配置”，不回显密钥；
- 测试只使用固定的无业务内容样本，不进入正式候选和 Obsidian；
- 测试本身产生带 `purpose = provider-health-check` 的模型 trace。

设置页新增“模型调用记录”：

- 默认显示时间、用途、后端、模型、状态、Token 和总耗时；
- 展开后显示本次实际输入、可见原始输出、结构化输出和回退原因；
- 输入、输出区域独立滚动并支持复制；
- 支持单条删除、删除整组和全部清空；
- 显示保留期、条数上限和“停止记录正文”开关；
- 关闭正文追踪后仍显示来自 `capture-audit` 的聚合成功/失败统计，但不伪装成完整追踪。

追踪查看是普通设置面板，不使用吸顶决策岛，不干扰正在进行的理由或候选流程。

## 11. 安全与隐私

- Hook 仍是被动观察者，失败必须静默放行宿主；
- 新网关只在 Desktop 进程运行，不把模型调用放进 Hook；
- 远程后端默认禁用；
- 输入仍只包含裁剪后的当前问答与有限上下文，不发送完整 transcript；
- 不记录隐藏思维、完整 CLI JSONL、环境变量、HTTP headers 或 API key；
- API 请求正文不写入系统通用日志；
- CLI 提示词走 stdin，不出现在 `ps` 参数中；
- CLI 工作目录是临时空目录，工具被禁用或置于只读沙箱；
- 子调用递归标记由 Bridge 在读取 stdin 前检查；
- 自定义 API 默认只允许 HTTPS，loopback 是唯一 HTTP 例外；
- 不接受任意 CA 禁用、TLS 跳过或任意 shell 参数设置；
- ModelTraceStore 不是事实来源，可随时删除；
- Markdown 仍是唯一正式决策事实来源，SQLite 仍可从 Markdown 重建。

## 12. 错误模型

统一稳定错误码至少包括：

```text
provider_disabled
provider_unavailable
provider_auth_failed
provider_quota_exceeded
provider_timeout
provider_network_failed
provider_invalid_output
provider_response_too_large
provider_model_unsupported
provider_process_failed
provider_version_unsupported
credential_unavailable
credential_decryption_failed
trace_write_failed
cancelled
unknown
```

追踪写入失败不能改变模型调用结果，也不能卡住原生客户端。对于能关联到语义配对的正式
判断，它向现有无正文审计写入非终止错误 `trace_write_failed`；无会话关联的后端测试只更新
设置页当前诊断状态。两者都不得写入正文或密钥。模型调用失败也不能删除已经成功写入的前置
attempt trace。

## 13. 迁移与兼容

- 现有 App Settings v2 迁移时保留 vault 和主题；
- Provider profile 使用独立版本化仓库，避免每新增一种后端都升级主设置；
- 首次迁移创建 Apple、Qwen、Codex CLI、Claude Code CLI 四个 profile；
- Apple、Qwen 保持原有启用顺序；
- CLI profile 只完成发现，不自动启用或发起真实文本调用；
- 现有 Hook 安装格式和 `DECISION_HOOK=2` 标记保持兼容；
- 安装器继续只替换 Decision 自己的被动 Hook，并清理历史 MCP；
- 旧 `capture-audit` 文件不迁移为有正文 trace；
- 更新 `docs/semantic-recognition.md`，明确两类日志的差别和清理方式。

## 14. 测试与评估

### 14.1 协议与存储

- Model trace schema 接受完整成功、部分 usage 和各类失败；
- 拒绝负 Token、错误总数、超长正文和未知错误码；
- Store 验证 `0700` / `0600`、原子写、保留期、条数上限、删除和 quarantine；
- 关闭正文追踪后不保存 input/output；
- 凭据、header、主目录和临时路径脱敏；
- CaptureAuditStore 保持无正文兼容。

### 14.2 网关

- 成功时只返回第一个有效 profile；
- timeout、invalid output、auth failure 和进程退出按规则回退；
- 每个 attempt 都有独立 trace；
- trace 写失败不改变调用结果；
- 取消会终止正在运行的 HTTP 请求或子进程；
- 规则最终回退不会伪造一个模型成功 trace。

### 14.3 API 适配器

- 使用本地 mock HTTP server，不在自动测试中使用真实密钥或产生费用；
- 验证请求不含工具、设置正确结构化 Schema、OpenAI `store: false`；
- 覆盖 usage、cached token、reasoning token、请求 ID 和错误映射；
- 覆盖超时、429、401、无效 JSON、过大响应和跨域重定向拒绝；
- 验证任何日志和异常都不含密钥。

### 14.4 CLI 适配器

- 使用 fake executable 固定输出 Codex JSONL 和 Claude JSON fixtures；
- 验证固定参数、stdin 提示词、临时目录、无会话、无工具和超时；
- 验证 `DECISION_PROVIDER_CHILD=1`；
- Bridge 在子调用标记存在时不读取、不落盘、不通知 Desktop；
- 覆盖 CLI 版本变化、Token 缺失、非零退出、stderr 脱敏和进程组终止；
- 真实本机 smoke 只使用固定无业务测试样本，由用户显式触发。

### 14.5 语义质量

- 现有 64 条合成脱敏语料继续作为基础回归；
- 每个可用后端单独生成 precision、recall、关联准确率、延迟和 Token 报告；
- 网关默认路由也生成整体报告；
- 高置信 precision ≥ 95%、high + medium recall ≥ 90% 的门槛保持不变；
- 后端测试和模型 trace 不进入训练集；
- 用户确认/忽略候选仍是后续标签来源。

### 14.6 完整验证

- 全量单元与集成测试；
- TypeScript 类型检查；
- Electron 打包；
- Bridge doctor、dry-run、apply；
- 已安装 App smoke；
- 设置页人工验证新增、测试、排序、查看和删除；
- 真实 Codex / Claude Code 测试后确认没有产生候选、理由岛或可恢复子会话；
- Obsidian 和 SQLite 检查确认没有模型 trace 或密钥。

## 15. 实施顺序

1. 协议、ModelTraceStore、TraceMiddleware 和通用网关；
2. 把 Apple / Qwen 迁移到网关，并让现有判断立即产生追踪；
3. Provider profile、CredentialVault 和设置 IPC；
4. OpenAI、Anthropic、OpenAI-compatible API 适配器；
5. Codex CLI、Claude Code CLI 适配器与递归捕获保护；
6. 设置页后端管理与调用追踪查看；
7. 文档、评估报告、打包、安装和真实 smoke。

每一步使用 TDD，并在各适配器完成后运行相关子集和全量回归。不得为了让 API/CLI 后端通过
而放宽现有结构化输出校验或高置信路由护栏。

## 16. 验收标准

- Apple 或 Qwen 完成一次真实判断后，设置页能看到实际输入、可见输出、结构化结果、模型、
  耗时和明确的 Token 来源；
- OpenAI、Anthropic 和一个 OpenAI-compatible mock profile 均能配置、测试和执行结构化判断；
- Codex CLI 和 Claude Code CLI 均能被发现、配置、测试并作为判断后端调用；
- CLI 调用不执行工具、不读取真实工作区、不保存会话、不触发 Decision 递归捕获；
- API Key 在设置、追踪、stderr、Markdown、SQLite 和进程参数中均不可见；
- 一个后端失败时，追踪能完整显示失败 attempt 和最终成功或规则回退；
- 用户能关闭正文追踪、删除单条、删除整组和全部清空；
- 7 天或 1,000 条限制能自动生效；
- 现有 Claude Code / Codex 原生交互、被动 Hook、理由流程、待处理队列和 Obsidian 写入无回归；
- 全量测试、类型检查、打包和安装后 smoke 通过。

## 17. 参考

- OpenAI Responses API usage：
  https://platform.openai.com/docs/api-reference/responses-streaming
- Codex CLI `exec` reference：
  https://developers.openai.com/codex/cli/reference
- Claude Code CLI reference：
  https://code.claude.com/docs/en/cli-usage
- Anthropic Messages API：
  https://platform.claude.com/docs/en/api/messages
