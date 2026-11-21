# 模型网络 Fail-Closed 策略

2026-11-02 审计与实施。策略固定为 `required`，不提供外部 DIRECT 降级开关，不更改系统代理或防火墙。

## 配置与行为

- 桌面应用可在“模型”页独立的“全局模型代理”区块的“全局模型代理地址”中填写 HTTP(S) 代理并保存，立即生效，无需设置环境变量。地址不包含账号密码、路径、查询参数或片段，留空时采用各后端的自定义代理。
- 优先级为：启动环境 `MODEL_PROXY_URL` → 界面保存的全局代理 → Provider 自定义代理。环境变量一旦存在就优先使用，即使值为空或无效也不会降级。认证代理仍通过启动环境配置，环境变量值不会暴露到界面快照中。
- `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 不再作为模型代理来源。`NO_PROXY`、`no_proxy` 不参与模型路由；已有配置里的非空 `proxy.noProxy` 被拒绝，编辑后重新保存可清除旧 bypass。
- 没有有效代理、连接被拒绝、代理认证失败、TLS 验证失败或响应流中断，请求只能失败。每次调用、重试和 fallback 均重新执行策略；不会改用 DIRECT。重定向仍被拒绝。
- 本机 HTTP 模型也默认需要代理。显式设置该 Provider 的 `proxy.mode=direct`，或设置进程环境 `MODEL_ALLOW_LOOPBACK=true`，才允许 HTTP Provider 对 `127.0.0.1`、`[::1]`、`localhost` 直连。`localhost` 在发送前固定为 `127.0.0.1`，避免 DNS/hosts 将例外指向外部；HTTPS localhost 服务需使用对应 IP 的证书。例外不允许其他私网地址。CLI 的 endpoint 可能隐藏在客户端配置中，因此 CLI 不开放 DIRECT/loopback 例外。开启后，必须信任本地服务不会自行转发到外部模型。
- 全局地址沿用现有设置仓库，单独保存在 settings-extra.json，兼容旧版本；主进程的共享 Model Transport/Factory 与 CLI 发现、生成、模型目录探测读取同一份实时配置。界面不再提供 bypass 列表。

## 请求路径审计

| 路径 | 实现与策略 |
| --- | --- |
| OpenAI Responses | `OpenAIResponsesAdapter.invoke/generate → HttpModelTransport → ModelNetworkPolicy → undici.fetch(dispatcher: ProxyAgent)` |
| Anthropic Messages | `AnthropicMessagesAdapter.invoke/generate`，同一 Transport；没有另行创建 Anthropic SDK |
| OpenAI 兼容（含 DeepSeek 等自定义 baseURL） | `OpenAICompatibleAdapter` 的 Chat Completions 与 Responses 均使用同一 Transport |
| Decisions / 判定模型 | `OpenRouterDecisionClient` 的 System One 与 OpenAI 协议、健康探测、逐 Provider fallback 使用同一 Transport |
| 模型目录探测 | `queryCliServerModels → HttpModelTransport.getJson`；官方 OAuth 模型目录同样需要代理 |
| 聊天、标题、后台任务 | `decision-assistant-service`、`methodology-service`、`practice-asset-service`、`pr-comment-recognition`、`client-onboarding-service`、`index` 中的生成工作均使用 `ProfiledModelGateway`，到以上适配器；没有独立的标题 HTTP Client |
| PR 评审、流式事件和重试 | `pr-review-service` 显式提供 `streamFn`，实际模型步骤调用 Gateway；pi-ai 只创建本地事件流。重试重新调用 Gateway |
| HTTP 响应流 | Transport 在同一代理连接上限量读取响应 body，超时/取消/大小限制仍有效；当前远程协议只消费完整 JSON，不支持 SSE token 输出，不增加新的 SSE Client |
| Embedding | 当前只有 `QwenEmbeddingProvider → LocalEmbeddingClient → local-model-host`，通过 Electron utilityProcess IPC 执行本地模型，没有外部 embedding Provider；未来新增外部 embedding 必须使用同一 Transport |
| Codex / Claude CLI | `minimalClientEnvironment → ModelNetworkPolicy.cliEnvironment → ManagedChildProcessRunner(required)`；启动前校验、重写代理变量，并清空全部绕过规则。原生 HTTP/SSE/WebSocket 由 CLI 自身实现代理 |
| 本地生成/分类 | Apple Foundation helper（Swift 子进程）与 Qwen（node-llama-cpp utilityProcess）为显式的本地计算，不调用远程模型 API |
| IPC / 动态配置 | Renderer 传递 profile 到主进程的已有 schema 验证；最终请求 URL 在 Transport 再验证，每次重新选择路由。Renderer 无网络 dispatcher 或不受约束的 fetch 入口 |

没有使用 `setGlobalDispatcher`。模型使用项目现有 Undici 7.30.0 的 `ProxyAgent` 与同包 `fetch`；每次调用显式传 dispatcher，并在成功、失败与流中断后销毁。非模型 PR 平台使用重命名后的 `createPlatformDispatcher` 保持原网络行为。

## 子进程与工程边界

- Codex CLI、Claude Code CLI 的应用内模型执行已恢复：在 `minimalClientEnvironment` 和 `ManagedChildProcessRunner(required)` 两处使用同一个策略校验。`MODEL_PROXY_URL` 优先，其次是界面保存的全局代理，否则采用 profile 自定义代理；缺失/异常/外部 DIRECT/非空配置 bypass 在 spawn 前拒绝。标准大小写 HTTP(S)/ALL 代理变量全部写成同一个值，`NO_PROXY/no_proxy` 清空；继承的其他代理覆盖变量会被删除。
- CLI 诊断和目录探测也使用同样的策略，CLI 服务端模型列表的 HTTP 请求仍经过 Transport；离线目录缓存只表示有候选名称，不代表当前代理连接成功。
- Claude 模型执行使用 `--safe-mode --setting-sources ""`，避免用户/项目 settings 的 env 重写受管代理；Codex 使用 `--ignore-user-config`，并显式关闭系统代理发现与系统代理 fallback。系统设置本身没有被修改。
- `evaluate-semantic-classifier.mjs`、`evaluate-pr-comment-recognition.mjs`、`replay-pr-review.mjs` 等复用适配器的模型执行自动采用这套策略。
- `scripts/lab/context-run.mjs` 的 `runAgent`、`capture-run.mjs` 的 `runProcess` 仍保留独立脚本入口的阻断；它们还允许其他客户端、用户 Hook 和不同 settings 来源，不能把应用内 CLI 的测试结果直接用于解除这些入口的阻断。本次真实 CLI 验证入口是 `scripts/lab/cli-proxy-check.test.ts`。
- `apps/bridge` MCP 只通过经身份核对的 loopback API 访问应用；它不调用外部模型。`scripts/lab/mcp-guard.mjs` 只启动桥接进程并转发 MCP，不提供第三方客户端的出站约束。
- `scripts/install-local-macos.py` 的 urllib 请求只用于本机 `/health`。本机模型下载 `prepare-local-model.mjs`、构建/签名/安装、git、CLI `--help` / `--version` / `mcp list/add/remove` 等管理命令不属于模型推理 Transport；这些进程和下载流量没有获得本策略的网络隔离保证。
- 用户自行启动的 CLI、Python、MCP Server 或第三方客户端不在应用进程控制范围内；需要它们自身匹配的代理实现或独立网络隔离，不能声称已被 Node dispatcher 保护。显式 loopback 例外后的本地转发行为同样不受本策略约束。

## 日志与依赖约束

Transport 输出结构化 `model-network` 日志：provider、model、policy、route、result、HTTP status 和错误码。`proxy_failed` 表示代理路径连接失败（也可能是目标 TLS 失败），不是断言代理服务器本身故障；收到模型 HTTP 错误另外记录。连接失败没有直接请求重试。日志不包含 URL、headers、请求/响应正文或代理凭据；model 字段同样经过已有密钥脱敏器。CLI 输出 provider、model、策略、路由、成功/失败/阻断与错误码（CLI 的 route 表示注入的策略，逐连接结论由测试服务观测），Gateway 保留原有调用追踪；模型进程诊断也会清理代理及常见凭证环境变量的值。该日志是进程日志，不另外持久化；需要留档时由启动环境采集标准输出。

仓库原来没有 ESLint；沿用脚本/Vitest 检查机制，`npm run lint` 使用现有 Vite 依赖中的 Rolldown AST 解析器审查 `apps` / `packages` 生产源码，禁止业务直接导入 SDK/HTTP 客户端、创建 Client/dispatcher、原生 fetch、动态网络模块、全局 dispatcher，以及未经审计的子进程。PR 平台、桥接、HTTP Server 和本地 helper 是明确的非模型白名单。`npm run check` 包含此检查。静态检查防止工程误用，不是针对任意恶意代码的 OS 网络沙箱。

## 验证

`provider-network.test.ts` 使用本地模型服务、CONNECT 代理、临时 TLS 证书和已关闭端口，覆盖：

- 全部注册外部 HTTP Provider / 协议的真实生成、分类与分块响应；成功时核对 CONNECT 和服务计数。
- 缺失/空值/错误协议/路径/query/控制字符代理配置，默认拒绝 loopback，以及显式本机例外。
- 代理端口关闭、407、恢复、响应流中断；失败后模型服务计数不增加（流中断只计已发出的那一次），不会出现额外直连。
- HTTP / HTTPS CONNECT，保留目标 TLS 证书验证；代理认证只发给代理，不发给模型服务。
- `NO_PROXY=*`、配置 bypass、外部 DIRECT、动态 baseURL、Gateway 重试/fallback、Decisions 两种协议和 fallback。
- 区分代理连接失败与模型 401、404、429、503，避免把模型错误当成断网证明。
- CLI 无有效代理时 spawn 前阻止、有代理时标准化与放行、网络日志脱敏和依赖边界的反例检查。Apple/Qwen 的既有适配器与 embedding 测试覆盖本地路径。

## 本机 CLI 断代理验证

`PARASELF_LIVE_CLI_PROXY=1 npm test -- --project unit scripts/lab/cli-proxy-check.test.ts` 是显式启用的本机 CLI 测试。可通过 `PARASELF_CODEX_EXECUTABLE`、`PARASELF_CLAUDE_EXECUTABLE` 指定实际二进制，避免 PATH 上另一版本影响结论；`PARASELF_CLI_PROXY_REPORT` 可指定报告路径前缀。路径不写死在源码或报告中。

该入口复用 `isolated-app.mjs` 的 `isolationEnvironment`：临时 HOME/CODEX_HOME/CLAUDE_CONFIG_DIR、合成 API key、临时 CA、本地 HTTPS 模型服务与 CONNECT 代理。调用经生产 `ManagedChildProcessRunner(required)`，不读取真实 Paraself 数据，不访问真实付费模型，不修改用户 CLI 配置或系统网络设置。

验证版本与结果：

| 客户端 | 成功与流式 | 429 内部重试 | 关闭代理端口 | 恢复代理 | 直连模型请求 |
| --- | --- | --- | --- | --- | --- |
| Codex CLI 0.166.0 HTTPS/SSE | 通过 | 通过 | 持续等待网络，由 10 秒请求期限终止，错误码 timeout；新增模型请求 0 | 通过 | 0 |
| Codex CLI 0.166.0 WebSocket | 通过，确实发生 WebSocket upgrade | 通过 | 同上；新增模型请求 0 | 通过 | 0 |
| Claude Code 2.1.316 HTTPS/SSE | 通过 | 通过 | CLI 返回失败，新增模型请求 0 | 通过 | 0 |

模型服务通过代理上游连接的源端口区分代理请求和直接请求；测试既要求成功输出，也核对所有模型请求经过代理。另注入 401，核对这是通过代理到达模型服务后发生的鉴权失败；CONNECT 代理要求 Basic 认证，并验证模型端没有收到代理认证头。缺失/异常代理配置和绕过规则由单元测试验证启动前拒绝。

边界：验证覆盖上述本机版本的受测调用路径；客户端升级、未知 provider、订阅 OAuth 登录/刷新、CLI 插件/MCP/工具自行发起的网络请求需要另行验证。环境变量不是 OS 网络隔离，不声称能约束任意第三方进程。Codex 断网时不会自行及时退出，必须保留应用已有的期限和进程组清理。没有做真实订阅鉴权或外部模型实跑。

代理机制参考：[Undici ProxyAgent 官方文档](https://undici.nodejs.org/api/ProxyAgent)，实现同时核对了仓库安装的 7.30.0 文档。[Claude Code 代理说明](https://code.claude.com/docs/en/network-config) 与 [Codex 网络配置边界](https://learn.chatgpt.com/docs/enterprise/managed-configuration#use-the-system-proxy-for-native-client-requests) 仅作为配置依据，断连结论来自本机测试。

## 本次检查与修改文件

2026-11-02：代码已合入本地 main（f2d07e9d），完成 macOS arm64 构建、ad-hoc 签名验证、隔离打包冒烟及本机替换，安装脚本返回 healthy=true。安装包与构建产物 app.asar 的 SHA-256 相同：`caca43c92f3892626aa0909ae263f6f89dadac77c0cc03c2fc83c3fe3d7b05b0`。没有推送远端或发布新版本。

`npm run lint`、`npm run typecheck`、`git diff --check` 均通过；全部单元测试在 `--maxWorkers=4` 下 5860 项通过、8 项条件跳过，6 组隔离 Electron 检查通过；本机 CLI 显式实测 3 项通过。全核并发时一项已有 PR 界面等待用例出现超时，单独及受控并发复验通过，未修改其业务代码。未调用真实订阅 OAuth 或真实外部模型。

界面沿用每个后端的“网络代理”：使用 MODEL_PROXY_URL 或自定义 HTTP/HTTPS 代理；CLI 不再提供直连选项，所有后端取消绕过主机列表。已增加“全局模型代理地址”输入框，也不提供关闭强制策略的开关。未配置有效代理时，外部模型请求会被阻止。

- `apps/desktop/src/main/model/adapters/anthropic-messages-adapter.ts`
- `apps/desktop/src/main/model/adapters/claude-code-cli-adapter.ts`
- `apps/desktop/src/main/model/adapters/codex-cli-adapter.ts`
- `apps/desktop/src/main/model/adapters/openai-compatible-adapter.ts`
- `apps/desktop/src/main/model/adapters/openai-responses-adapter.ts`
- `apps/desktop/src/main/model/cli/cli-adapter-support.ts`
- `apps/desktop/src/main/model/cli/cli-discovery.ts`
- `apps/desktop/src/main/model/cli/cli-model-catalog.ts`
- `apps/desktop/src/main/model/cli/cli-model-server.ts`
- `apps/desktop/src/main/model/cli/managed-child-process.ts`
- `apps/desktop/src/main/model/http-model-transport.ts`
- `apps/desktop/src/main/model/openrouter-decision-client.ts`
- `apps/desktop/src/main/model/provider-network.ts`
- `apps/desktop/src/main/pr-platform-client.ts`
- `apps/desktop/src/renderer/components/ModelProviderPanel.tsx`
- `apps/desktop/test/App.test.tsx`
- `apps/desktop/test/anthropic-messages-adapter.test.ts`
- `apps/desktop/test/claude-code-cli-adapter.test.ts`
- `apps/desktop/test/cli-discovery.test.ts`
- `apps/desktop/test/cli-model-catalog.test.ts`
- `apps/desktop/test/codex-cli-adapter.test.ts`
- `apps/desktop/test/http-model-transport.test.ts`
- `apps/desktop/test/model-content-refused.test.ts`
- `apps/desktop/test/model-provider-panel.test.tsx`
- `apps/desktop/test/openai-responses-adapter.test.ts`
- `apps/desktop/test/provider-network.test.ts`
- `docs/model-network-policy.md`
- `package.json`
- `scripts/lab/capture-run.mjs`
- `scripts/lab/cli-proxy-check.test.ts`
- `scripts/lab/context-run.mjs`
- `scripts/lab/context-run.test.mjs`
- `scripts/lint-model-network.mjs`
- `scripts/test/model-network-boundary.test.ts`
- `scripts/test/package-scripts.test.ts`
- `scripts/test/replay-pr-review-decisions.test.ts`
- `scripts/test/replay-pr-review.test.ts`

## 全局代理入口与客户端提示修复

补上桌面界面的全局代理输入框、持久化和 IPC 输入校验；保存后刷新客户端状态并立即应用到所有外部 HTTP/CLI Provider。缺失或无效代理使用独立的 proxy_required 状态，界面显示“需要配置网络代理”，不再误报“客户端检查失败”。全局表单不接受凭证 URL，启动环境仅返回“覆盖已启用”的标记，不把环境变量中的代理凭证传到 renderer。

本轮验证：5870 项单元测试通过，71 项隔离 Electron 设置页检查通过，lint/typecheck 通过。使用全局代理读取路径只检查本机客户端版本、能力及登录状态，Codex 0.166.0 与 Claude Code 2.1.316 均 available；没有发起真实模型生成。

全局代理在“模型”页作为独立卡片，位于模型后端与判定模型之前；输入控件限制最大宽度，并在浅色标准窗口、深色窄窗口验证对齐与无溢出。System One 和 OpenAI 两类判定模型额外用模拟服务验证读取全局代理及断连后不直连。
