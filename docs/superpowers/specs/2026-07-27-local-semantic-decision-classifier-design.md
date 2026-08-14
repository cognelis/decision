# Decision 本地语义决策识别设计

日期：2026-07-27

状态：已确认并实现

## 1. 背景

Decision 已通过 Claude Code 和 Codex 的被动 Hooks 捕获原生工具问答和普通文本问答。
普通文本路径目前由 `rules-v1` 判断：

- 高置信度直接进入理由流程；
- 中置信度进入待确认候选；
- 低置信度丢弃。

真实使用中出现了明显漏报。一个代表性样本的末段是：

> 两仓仍未提交。是先处理技术债，还是先提交当前这批？

用户随后回答了处理范围，同时又提出一个新的实现问题。按现有规则，这个问题本应得到
100 分的回答前分数，回答也与“处理”存在词汇关联。现场记录还显示 Stop hook 已执行且没有
hook error，但对应内容没有进入 pending、candidate、capture spool 或 Obsidian。

这个样本说明当前问题包含两类根因：

1. **采集链路丢失**：Hook 已触发，但没有留下可定位的阶段结果；
2. **语义能力不足**：规则难以稳定理解改写回答、混合回答、隐含选项和跨句指代。

本设计同时处理这两类问题。只接入模型不能修复第一类问题。

## 2. 目标

### 2.1 产品目标

- 不改变 Claude Code 或 Codex 的任何原生交互；
- 不要求 LLM 调用 Decision MCP 或专用工具；
- 提高普通文本决策的召回率；
- 保持直接弹出理由岛的低误报；
- 能定位每次漏报发生在采集、配对、分类还是持久化阶段；
- 模型不可用、超时或异常时，Hooks 和原生客户端仍正常工作；
- 所有语义判断默认在本机完成。

### 2.2 质量目标

在固定真实语料上：

- 高置信度 precision 不低于 95%；
- 高 + 中置信度 recall 不低于 90%；
- 混合回答中只要包含对上一决策的有效回应，不得直接当作无关新任务丢弃；
- 原生工具问答路径不得出现行为回归；
- Hook 自身 p95 不高于 150 ms；
- 模型推理不得阻塞 Hook 返回；
- 模型或 helper 崩溃不得导致 Claude Code、Codex 卡住或报错。

### 2.3 非目标

- 不采集或推断模型隐藏思维过程；
- 不把 Apple 或 Qwen 模型输出作为新的事实来源；
- 不让模型直接写 Obsidian、SQLite 或候选队列；
- 不在当前阶段训练或微调自有模型；
- 不调用云端分类 API；
- 不把 Qwen 权重直接塞进主安装包；
- 不替换原生 `AskUserQuestion` 或 `request_user_input`。

## 3. 核心判断

这不是单一的“文本分类”功能，而是四个独立层次：

1. **采集**：是否拿到当前 assistant 文本和下一条用户输入；
2. **决策意图**：assistant 是否正在等待人类做选择、批准或方向判断；
3. **问答关联**：下一条用户输入是否全部或部分回应了该决策；
4. **结构提取**：定位问题、选项、答案和有限上下文。

本地模型只参与第 2、3 层，并为第 4 层提供建议。第 1 层和最终结构校验保持确定性。

## 4. 方案选择

采用“可观测采集 + 规则与本地模型联合分类”的混合方案。

不采用完全模型化，原因是：

- 模型无法判断自己是否根本没有收到文本；
- 原生工具问答和明显规则样本不需要模型；
- 模型随系统或权重版本变化，不能承担持久化和路由的全部责任；
- 完全依赖模型会让跨平台、离线和故障降级变得脆弱。

不采用继续堆叠正则作为最终方案，原因是：

- 自然语言回答经常不复述选项；
- 一个输入可能同时回答旧问题并提出新问题；
- 指代、否定、范围限定和隐含优先级需要语义理解；
- 规则可以提供护栏，但难以稳定覆盖真实表达。

## 5. 总体架构

```text
Claude Code / Codex Hooks
  │
  ├─ 原生问答成功事件 ───────────────→ 现有结构化捕获路径
  │
  └─ 普通 assistant / user 文本
       │
       ▼
  Hook Observer
       ├─ 有限文本读取
       ├─ 原子写入语义配对 spool
       ├─ 写入无正文阶段收据
       └─ 立即返回，不运行本地模型
       │
       ▼
  Desktop Semantic Worker
       ├─ 确定性清洗与边界提取
       ├─ Rule Classifier
       ├─ Apple Foundation Models Provider
       ├─ 可选 Qwen Provider
       └─ Ensemble Router
       │
       ├─ high   → 现有理由队列
       ├─ medium → 待确认候选队列
       └─ low    → 丢弃正文，保留去重与审计收据
```

### 5.1 为什么模型不在 Hook 中运行

Hook 必须是安静、快速、不会改变宿主行为的观察者。Apple 模型存在首次加载、系统繁忙、
模型未就绪和版本变化；Qwen 还存在进程启动和权重加载。任何同步推理都可能延迟用户的下一条
输入或触发 5 秒 hook timeout。

因此 Hook 只做有限读取、原子落盘和短连接通知。语义推理由已经运行的桌面 App 异步完成。
App 不运行时不主动唤醒，只保留有过期时间的待分类配对；下次启动后恢复处理。

## 6. 采集与阶段收据

### 6.1 语义配对 spool

普通文本 Stop 先保存 assistant 轮次，下一次同客户端、同会话的 UserPromptSubmit 补上用户
输入，形成 `SemanticDecisionPair`：

```ts
interface SemanticDecisionPair {
  version: 1;
  pairId: string;
  sourceClient: "claude-code" | "codex";
  sessionId: string;
  assistantTurnId?: string;
  userTurnId?: string;
  cwd: string;
  assistantText: string;
  userText: string;
  capturedAt: string;
  expiresAt: string;
}
```

约束：

- assistant 文本最多 8,000 字符；
- user 文本最多 2,000 字符；
- 只保留当前 assistant 轮次和下一条用户输入；
- 不保存完整 transcript 或 transcript 路径；
- 目录权限为 `0700`，文件为 `0600`；
- 未完成配对 24 小时过期；
- 已完成但未分类的配对 7 天过期；
- 完成正式路由后删除正文，只保留不含业务内容的收据。

### 6.2 阶段收据

新增独立的本地派生审计日志，不进入 Obsidian：

```ts
interface CaptureAuditReceipt {
  version: 1;
  receiptId: string;
  sourceClient: "claude-code" | "codex";
  sessionFingerprint: string;
  turnFingerprint?: string;
  stage:
    | "hook_received"
    | "assistant_text_resolved"
    | "pending_saved"
    | "user_prompt_matched"
    | "pair_spooled"
    | "classification_completed"
    | "routed"
    | "failed";
  textSource?: "hook_payload" | "transcript_tail";
  ruleBand?: "high" | "medium" | "low";
  modelBand?: "high" | "medium" | "low" | "unavailable";
  finalBand?: "high" | "medium" | "low";
  errorCode?: string;
  durationMs?: number;
  createdAt: string;
}
```

收据不保存问题、答案、项目路径、会话原 ID 或异常堆栈。原 ID 通过安装级随机盐做 HMAC，
只用于把同一次处理的阶段串起来。收据保留 7 天，最多 5,000 条。

Hook 内所有异常仍被吞掉，以保证宿主流程不受影响，但必须尽力写入稳定的枚举错误码。

## 7. 本地模型提供者

### 7.1 统一接口

模型提供者只接收已经裁剪的当前问答对，并返回结构化语义判断：

```ts
interface SemanticClassifier {
  classify(
    input: SemanticClassifierInput,
    signal?: AbortSignal,
  ): Promise<SemanticClassification>;
}

interface SemanticClassification {
  decisionIntent:
    | "decision"
    | "approval"
    | "information_request"
    | "self_resolved"
    | "none";
  answerRelation:
    | "answers"
    | "mixed"
    | "new_task"
    | "uncertain";
  question: string | null;
  optionLabels: string[];
  confidence: number;
  provider: string;
  modelVersion: string;
  promptVersion: string;
}
```

模型不返回自由推理过程。所有字符串再次经过长度限制和源文本包含校验；模型不能凭空生成
正式问题或选项。

### 7.2 Apple Foundation Models

Apple provider 是当前 macOS 的首选语义提供者：

- 使用 `SystemLanguageModel.default`；
- 使用 guided generation 输出固定 Swift 结构；
- 启动时检查 `.availability`；
- 记录 macOS build、helper 版本和 prompt 版本；
- 不假设系统更新前后的模型行为一致；
- 每次请求设置超时和取消信号；
- 不调用 Private Cloud Compute；
- 不把输入发送到网络。

Decision 为 Electron 应用，因此增加一个随 App 打包的 Swift helper。helper 是长驻子进程，
通过私有 stdin/stdout JSON Lines 协议与 Electron main 通信。协议不开放监听端口，不接受其他
进程连接。

helper 不可用、Apple Intelligence 未开启、模型未下载完成或设备不支持时返回
`provider_unavailable`，不得弹错误框，也不得阻塞规则路径。

参考：

- [Apple Foundation Models](https://developer.apple.com/documentation/FoundationModels)
- [Generating content and performing tasks](https://developer.apple.com/documentation/FoundationModels/generating-content-and-performing-tasks-with-foundation-models)
- [Foundation Models updates](https://developer.apple.com/documentation/Updates/FoundationModels)

### 7.3 Qwen 备选

`Qwen3.5-2B` 是跨平台备选和评测对照，模型为 Apache 2.0。Decision 通过
`node-llama-cpp` 在 Electron main process 内管理本地 GGUF 推理，不要求用户安装 Ollama、
LM Studio 或其他常驻服务。

当前阶段：

- 使用 `node-llama-cpp@3.19.1`，只使用随应用打包的预编译二进制，禁止运行时源码构建；
- 默认量化产物为 `Qwen_Qwen3.5-2B-Q4_K_M.gguf`，精确大小
  `1,329,766,560` 字节；
- 权重不塞进主安装包，放在 `Application Support/Decision/models`；
- 模型清单固定在仓库提交 `915a52556175c333102d04f996380950d35155d9`，SHA-256 为
  `84aeb7fe40e7b833d71303d7f1b9f9c1991b931b5dbd214e0aa48d56a0af1f85`，加载前必须校验；
- 正式发布不静默下载约 1.33 GB 权重；由安装/设置中的明确本地模型准备动作完成；
- 当前开发机因 Apple provider 返回 `deviceNotEligible`，本次安装会显式准备 Qwen 权重；
- `getLlama({ build: "never", gpu: "auto", skipDownload: true })`，避免运行期下载工具链或二进制；
- 通过 JSON schema grammar 约束结构化输出，并再次执行应用侧枚举、长度和原文定位校验；
- 模型缺失、校验失败、加载失败、超时或内存压力时退回规则，不弹错误框；
- 只通过同一 `SemanticClassifier` 接口接入，不直接操作队列、Markdown 或 SQLite。

`Qwen3.5-0.8B` 只作为体积下限实验，`Qwen3.5-4B` 只在 2B 未达到指标时进入比较，不提前扩大
交付体积。

参考：

- [Qwen3.5-2B](https://huggingface.co/Qwen/Qwen3.5-2B)
- [Qwen3.5-4B](https://huggingface.co/Qwen/Qwen3.5-4B)
- [llama.cpp](https://github.com/ggml-org/llama.cpp)

## 8. 联合路由

原生工具问答不经过联合分类，继续使用现有结构化捕获。

普通文本配对由规则和可用模型分别判断：

| 规则结果 | 模型结果 | 最终路由 |
| --- | --- | --- |
| 高 | 高 | 高：进入理由队列 |
| 高 | 中或低 | 中：进入待确认候选 |
| 中 | 高或中 | 中：进入待确认候选 |
| 低 | 高或中 | 中：进入待确认候选 |
| 低 | 低 | 低：丢弃 |
| 任意 | 不可用或超时 | 使用规则现有结果 |

模型不能单独触发高置信弹岛。它只能与规则一致时确认 high，或把规则漏掉的语义样本提升到
medium。这样优先提高召回率，同时保护直接弹岛的 precision。

为了避免 App 重启后弹出已经失去时效的理由岛，完成配对超过 15 分钟后才被恢复处理的项目，
最终最高只能进入 medium 候选，不能直接路由为 high。

### 8.1 混合回答

`answerRelation = mixed` 表示用户既回答了上一决策，又提出了新问题。它不是 `new_task`。

对于 mixed：

- 如果模型识别出有效回答，至少进入 medium；
- 正式记录的答案保留完整原始用户输入；
- 模型可给出答案片段建议，但正式存储前必须能在原文中定位；
- 后续新问题仍完全交给 Claude Code 或 Codex，Decision 不进行任何回复。

截图中的“本次引入的需要处理，同时追问参数结构”属于 mixed。

## 9. 影子模式与评估

### 9.1 阶段

1. **Trace only**：只上线阶段收据和可重放配对，不改变现有路由；
2. **Shadow**：规则照常路由，Apple/Qwen 只记录无正文比较结果；
3. **Disagreement review**：规则与模型不一致的样本进入 medium 候选；
4. **Hybrid active**：达到门槛后，规则与模型一致 high 才直接进入理由队列。

每个阶段都可以通过版本化配置回退，配置不暴露为普通用户需要理解的阈值面板。

### 9.2 语料

固定语料至少包含 500 个脱敏真实轮次，并按来源、语言和表达类型分层：

- 明确二选一、多选、是非确认；
- 没有问号或没有编号选项的决定；
- 用户复述选项、改写选项、只给理由；
- 回答旧决策后继续提出新问题；
- 仅索取 API key、路径、日志等客观信息；
- assistant 已自行决定并继续执行；
- FAQ、引用、教程、代码、diff、日志中的问句；
- 同会话连续出现多个问题；
- Claude Code 和 Codex 各自的 transcript 形状；
- 当前现场漏报样本。

候选队列中的“是决策 / 不是决策”形成自然标签。新增现场漏报必须脱敏后加入固定回归集。
不为了计算 recall 而长期保存所有普通对话。

### 9.3 指标

分别报告规则、Apple、Qwen 和联合路由：

- high precision；
- high + medium recall；
- decision / information / self-resolved 混淆矩阵；
- answerRelation 准确率；
- 问题片段可定位率；
- 选项提取准确率；
- Hook p50 / p95 / 最大耗时；
- 模型 warm / cold p50 和 p95；
- helper 峰值内存、崩溃率和超时率；
- Apple 模型不可用率；
- 每次系统升级前后的回归差异。

阈值只用训练/校准集调整。最终门槛必须在从未用于调参的保留集上通过。

## 10. 数据与隐私

- Obsidian Markdown 仍是已确认决策的唯一事实来源；
- SQLite 仍只保存可重建的正式记录索引和状态；
- 语义配对 spool、候选 spool 和审计收据都是可过期、可重建的本地运行数据；
- 模型输入只包含当前有限问答对，不包含完整 transcript；
- 不保存模型自由推理；
- 不记录 transcript 路径；
- 不把 assistant/user 正文写入阶段收据；
- Qwen 权重只从固定清单准备，加载前验证 SHA-256；
- Qwen 推理不打开监听端口，也不发送网络请求；
- Apple provider 明确禁止 Private Cloud Compute；
- 用户忽略候选后删除正文，只保留去重与聚合所需的无正文收据。

## 11. 故障处理

- Hook 无法读取文本：写 `assistant_text_unavailable`，正常退出；
- pending 写入失败：写 `pending_write_failed`，正常退出；
- session 无法配对：写 `pair_not_found`，不猜测跨会话对应关系；
- App 未运行：保留 pair spool，不主动启动 App；
- Apple helper 未就绪：规则立即接管；
- 模型超时或输出无效：规则立即接管；
- helper 连续崩溃：本次 App 生命周期内熔断 Apple provider；
- Qwen 权重缺失或校验失败：标记 `model_missing` 或 `checksum_failed`，规则立即接管；
- Qwen native runtime 不可加载：标记 `runtime_unavailable`，规则立即接管；
- 联合分类持久化失败：pair 保留等待重试，不提前写成功收据；
- Markdown 保存成功但 SQLite 失败：沿用现有降级状态，Markdown 仍为事实来源。

## 12. 模块边界

### Bridge

- `HookTextObserver`
  - 解析 hook payload；
  - 读取有限 assistant/user 文本；
  - 写阶段收据；
  - 生成和完成 `SemanticDecisionPair`；
  - 不运行模型。

- `SemanticPairSpool`
  - 原子保存、过期、收据、去重和恢复；
  - 不理解文本语义。

### Desktop main

- `SemanticDecisionCoordinator`
  - 消费 pair；
  - 并发调用规则与可用模型；
  - 应用联合路由；
  - 把 high/medium 交给现有队列。

- `AppleFoundationModelProvider`
  - 管理 helper 生命周期、可用性、超时和协议；
  - 不接触 Markdown、SQLite 或窗口。

- `QwenSemanticProvider`
  - 在 Electron main process 中管理 `node-llama-cpp` 生命周期；
  - 只加载固定清单中校验通过的本地 GGUF；
  - 使用 JSON grammar 并限制上下文、输出 token、并发数和超时；
  - 遵循相同输入输出契约。

- `CaptureAuditStore`
  - 保存无正文阶段收据、容量和过期策略；
  - 为诊断页和测试提供聚合查询。

### Swift helper

- `decision-foundation-model-helper`
  - 调用 Apple Foundation Models；
  - guided generation 输出固定结构；
  - 一行请求对应一行响应；
  - 不访问文件系统、网络、Obsidian 或 Electron UI。

## 13. UI

当前阶段不增加模型聊天界面，也不让用户调阈值。

设置页新增只读“语义识别”状态：

- 当前提供者：Apple 本地模型 / Qwen 本地模型 / 规则；
- Apple Intelligence：可用 / 未开启 / 模型未就绪 / 设备不支持；
- Qwen：可用 / 模型缺失 / 校验失败 / 运行时不可用；
- 当前模式：Trace / Shadow / Hybrid；
- 最近 7 天：处理轮次、候选数、直接捕获数、阶段失败数；
- “查看诊断”入口只展示阶段、错误码和时间，不展示普通对话正文。

候选审查界面继续承担语义分歧的人类确认，不增加新的并行队列。

## 14. 测试策略

### 14.1 单元测试

- pair spool 原子写入、配对、过期和容量；
- 阶段收据不含正文、路径和原 ID；
- mixed / answers / new_task 的路由矩阵；
- 模型输出的长度、枚举和源文本定位校验；
- Apple/Qwen unavailable、timeout、invalid output；
- helper 熔断与恢复；
- 原生结构化问答绕过模型。

### 14.2 集成测试

- Claude Stop → UserPromptSubmit → pair → hybrid → high；
- Codex Stop → UserPromptSubmit → pair → medium；
- App 离线时 Hook 快速返回，pair 下次启动恢复；
- 模型进程崩溃时规则正常路由；
- Markdown 已保存但收据失败时不会重复记录；
- 截图对应的长 Markdown assistant 输出和 mixed 用户回答；
- 完整链路不修改 hook stdout 或宿主退出码。

### 14.3 性能与回归

- 64 KiB transcript 尾部读取；
- 8,000 + 2,000 字符最大 pair；
- 500 条固定语料批量评测；
- Apple 模型 warm/cold 基准；
- App 启动、退出和 helper 孤儿进程清理；
- 全量既有测试、类型检查、打包和 smoke。

## 15. 实施顺序

1. 定义 pair、审计收据和分类输出协议；
2. TDD 实现 `CaptureAuditStore` 和 `SemanticPairSpool`；
3. 把普通文本 Hook 改为可观测配对，但保持 `rules-v1` 路由结果不变；
4. 建立固定语料与离线评测报告；
5. TDD 实现 provider 接口和联合路由；
6. 实现并打包 Swift Foundation Models helper；
7. 上线 Shadow 模式并收集本机结果；
8. 接入候选分歧审查；
9. 达到指标后启用 Hybrid；
10. 在 Apple 不可用的机器上准备并校验 Qwen3.5-2B，作为自动本地备选；
11. 更新 README、安装、smoke 和恢复文档。

## 16. 验收标准

- 现场截图样本能够留下完整阶段收据；
- 现场样本不得因包含新问题而被判为纯 `new_task`；
- 规则与模型分歧时进入现有候选队列；
- 模型不可用时行为等同当前规则版本；
- Apple 推理不在 Hook 进程中发生；
- Qwen 推理只在 Electron main process 中发生，且不需要外部本地模型服务；
- Hook p95 仍不高于 150 ms；
- high precision 和 high + medium recall 达到约定门槛；
- 普通非决策正文不会长期进入审计日志；
- 不新增或恢复 Decision MCP；
- Claude Code 和 Codex 原生询问行为保持不变；
- Obsidian Markdown 仍是正式决策的唯一事实来源。

## 17. 实现说明

2026-07-27 的落地实现保持上述架构与路由约束，并有以下构建环境相关说明：

- 当前 Xcode Command Line Tools 可以编译 Foundation Models 框架，但没有提供
  `@Generable` 所需的宏插件。因此 Swift helper 使用公开的 `GenerationSchema`、
  `GeneratedContent` 和 guided generation API 动态声明同一固定结构；输出字段、枚举、
  长度限制和应用侧原文校验不变。
- helper 和 Qwen 清单打包在
  `Decision.app/Contents/Resources/semantic/`；Qwen 权重明确不进入 `.app`。
- `node-llama-cpp` 的 JavaScript 生产依赖进入 ASAR，`.node`、`.dylib` 和 `.so` 原生文件
  自动解包到 `app.asar.unpacked`。运行时禁止编译或下载二进制。
- 当前开发机探测结果为 `device_not_eligible`，因此实际安装显式准备并使用 Qwen；
  模型缺失时保持规则降级。
- 仓库先交付 64 条完全合成、脱敏的确定性回归集，用于防止实现退化。它不替代第 9 节要求
  的至少 500 条分层真实标签语料，也不表示当前规则基线已经达到激活门槛。
- 打包冒烟测试覆盖被动 Hook 静默退出、混合回答、结构化捕获、阶段收据、模型不可用时规则
  降级、理由后写入 Markdown、删除 SQLite 后从 Markdown 重建、helper 状态以及安装包不含
  GGUF 权重。
