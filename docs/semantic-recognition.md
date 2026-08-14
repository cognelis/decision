# 本地语义识别

Decision 只观察 Claude Code 和 Codex 已经发生的原生交互。它不注册问答 MCP，不替换 `AskUserQuestion` / `request_user_input`，不向模型注入指令，也不把任何响应写回客户端。Hook 收到事件后只做有限文本读取、私有落盘和短连接通知；即使 App、磁盘或分类器失败，Hook 也会静默放行原生流程。

## 它识别什么

普通文本捕获分为四层：

1. 采集当前 assistant 文本和下一条同会话用户输入；
2. 判断 assistant 是否把选择、批准或方向判断交给人类；
3. 判断用户输入是回答、回答后继续追问、无关新任务还是无法确认；
4. 从原文中定位问题、选项和答案片段。

这是一项受约束的语义识别，而不是读取 LLM 的隐藏思维过程。模型只参与第 2、3 层并为第 4 层提供建议。所有正式字符串都必须通过枚举、长度和原文包含校验；保存的答案始终是完整用户原文。

原生问答工具成功事件已经包含结构化问题、选项和答案，因此直接进入原有捕获路径，不调用语义模型。

## 提供者与路由

桌面 App 每次判断前重新读取模型后端配置，按用户可调整的优先级依次尝试所有已启用后端。首次运行只启用 Apple 和 Qwen；远程 API、Codex CLI 与 Claude Code CLI 都默认关闭，不会因为“检测到”而自动发送内容。

可用后端：

1. **Apple Foundation Models**：Apple Intelligence 提供的系统级设备端语言模型。Decision 通过随 App 打包的 Swift helper 使用 guided generation；helper 不监听端口，不访问 Obsidian，也不使用 Private Cloud Compute。
2. **Qwen3.5-2B**：Apple 模型设备不支持、未开启、资源未就绪或运行异常时的本地 GGUF 备选。由 `node-llama-cpp` 在 Electron main process 内加载，不需要 Ollama 或 LM Studio。
3. **OpenAI Responses**：使用严格 JSON Schema、空工具列表和 `store: false`。
4. **Anthropic Messages**：使用 Messages 结构化输出，不配置工具。
5. **OpenAI 兼容 API**：明确选择 Responses 或 Chat Completions。地址必须是 HTTPS；只有 `localhost`、`127.0.0.1` 或 `::1` 可以使用 HTTP。跨地址重定向不会被跟随。
6. **Codex CLI / Claude Code CLI**：使用客户端现有登录状态发起一次无工具、无会话、只读的结构化判断。它们通过本地进程启动，但模型请求通常仍会发送到对应服务商，因此界面明确标记为远程模型调用。
7. **规则识别**：所有已启用模型后端都不可用、超时或输出无效时立即接管。

每个后端失败都会留下独立 attempt 日志，然后网关继续尝试下一项。启用、禁用、排序、模型名、超时和客户端路径都在下一次判断生效；不需要重装 Hooks。后端“测试”使用固定无业务样本，并记录为 `provider-health-check`，不会写入候选、理由、Obsidian 或 SQLite。

同一后端顺序也用于显式发起的通用结构化生成。目前已启用的方法论、技能草案和工作流草案分别使用 `methodology-extraction`、`skill-drafting` 和 `workflow-drafting` 用途；每种用途都有独立的严格 JSON Schema、输出长度限制和逐后端调用留痕。原则、技能与工作流都支持人工编写：这些路径不进入模型网关，只记录“人工录入 / 不调用模型”或“人工整理 / 不调用模型”，并复用相同的 Schema 校验和候选审核边界。人工原则不会自动关联复盘证据；用户也可以先明确选择 1–5 条完整复盘，再用零模型人工整理表单建立带真实来源的候选，证据关系只来自这次人工选择。已采纳原则基于采用后新复盘建立修订草案时同样不调用模型，且只有明确应用后才更新稳定原则。人工实践资产仍保留来源原则快照和显式发布边界。Apple Foundation Models 仍只参与普通文本语义识别，通用生成会跳过它并继续尝试 Qwen、API 或终端后端。生成或人工编写的结果必须经过 Schema 校验和人工确认后才能成为已采纳原则或实践资产；只有用户随后在资产详情中明确确认发布，才会写入 Codex 或 Claude Code 的 Skill 目录，创建草案本身不会直接改变 Hooks 或客户端内容。

普通文本会同时得到规则档位和可用模型档位：

| 规则 | 模型 | 最终处理 |
| --- | --- | --- |
| 高 | 高 | 高：进入理由流程 |
| 高 | 中或低 | 中：进入待处理 |
| 中 | 高或中 | 中：进入待处理 |
| 低 | 高或中 | 中：进入待处理 |
| 低 | 低 | 低：丢弃 |
| 任意 | 不可用 | 使用规则结果 |

模型不能单独触发高置信弹岛。包含有效回答又继续提出新问题的 `mixed` 输入至少进入中置信待处理，且完整输入会作为答案保存。超过 15 分钟才恢复处理的配对最高也只能进入待处理，避免重启后突然弹出过时决策。

Qwen 首次使用允许最多 30 秒完成冷启动，后续单次生成仍受 5 秒限制。分类在后台异步执行，不阻塞 Claude Code 或 Codex 的原生交互。瞬时运行失败会先尝试下一个已启用后端，再回退到规则识别；30 秒后在下一次状态检查或配对分类时自动重新探测本地模型，初始化失败的运行资源不会被永久缓存。

待处理面板打开一次即可连续处理当前队列。忽略后直接显示下一项；记录后先进入理由流程，完成、跳过或稍后补充理由后自动返回下一项。面板优先展示完整决策原文、用户回答和问题相关上下文，未确认内容仍只保存在私有 `candidate-spool`。

## Qwen 模型准备

固定产物：

| 项目 | 值 |
| --- | --- |
| 文件 | `Qwen_Qwen3.5-2B-Q4_K_M.gguf` |
| 大小 | 1,329,766,560 字节，约 1.33 GB |
| SHA-256 | `84aeb7fe40e7b833d71303d7f1b9f9c1991b931b5dbd214e0aa48d56a0af1f85` |
| 上游提交 | `915a52556175c333102d04f996380950d35155d9` |
| 模型许可 | Apache-2.0 |
| 运行库 | `node-llama-cpp@3.19.1`，MIT |

语义检索另使用官方专用嵌入模型：

| 项目 | 值 |
| --- | --- |
| 文件 | `Qwen3-Embedding-0.6B-Q8_0.gguf` |
| 大小 | 639,150,592 字节，约 639 MB |
| SHA-256 | `06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439` |
| 上游提交 | `d20cf9c16f82914a21dbd9c645f56895fb1d7750` |
| 模型许可 | Apache-2.0 |
| 向量维度 | 1024 |

权重不包含在 `.app` 中，也不会静默下载。明确执行：

```bash
npm run prepare:model
```

默认写入：

```text
~/Library/Application Support/Decision/models/Qwen_Qwen3.5-2B-Q4_K_M.gguf
~/Library/Application Support/Decision/models/Qwen3-Embedding-0.6B-Q8_0.gguf
```

下载使用 HTTPS、最多跟随 5 次重定向，写入权限为 `0600` 的 `.partial` 文件，支持 Range 续传。达到清单大小后验证 SHA-256，再原子改名为正式文件。目标目录权限为 `0700`；脚本拒绝符号链接以及 `.app/Contents` 内的目标。

只检查、不下载：

```bash
npm run prepare:model -- --check
```

结果与退出码：

| 输出 | 退出码 | 含义 |
| --- | ---: | --- |
| `available` | 0 | 大小和 SHA-256 均正确 |
| `missing` | 2 | 尚未准备 |
| `checksum_failed` | 3 | 文件不是可信的固定产物 |

命令帮助：

```bash
node scripts/prepare-local-model.mjs --help
```

## 设置页诊断

设置页“语义识别”是只读的当前路由状态，显示：

- 当前实际提供者：第一个可用的已启用模型后端，或规则识别；
- 可用性：可用、Apple 智能当前不可用、Apple Intelligence 未开启、资源未就绪、模型未准备、校验失败或运行时不可用；
- 当前模式：混合识别；
- 最近 7 天处理数、高置信数、中置信数和终止采集、落盘或路由的失败数。未配对 Hook、模型超时和规则回退不算失败。

它不会显示阈值、运行令牌、问题、答案或项目路径。后端配置在下一次判断生效；分类中提供者失败时按顺序继续尝试下一项，全部失败后降级到规则。

设置页“模型调用记录”单独显示 Decision 自己发起的模型判断。每个后端尝试一条记录，包括实际提交的 system/user prompt、提供者返回的可见文本、通过校验的结构化结果、模型与 prompt/schema 版本、耗时、状态以及 Token 来源。Qwen 使用模型运行时的 token meter，标记为 `runtime_measured`；Apple Foundation Models 没有可靠 Token API 时明确显示“Token 不可用”，不会用字符数伪装。

模型输入输出正文默认开启记录，只影响新的调用，可在设置页关闭。关闭后仍保存无正文的 attempt 元数据和原有 `capture-audit` 聚合信息。用户可以删除单条记录、同一次请求的全部后端尝试，或二次确认后清空全部记录。

设置页“模型后端”支持：

- 添加 OpenAI、Anthropic 或 OpenAI 兼容 API；
- 保存模型名、服务地址、协议和超时，并用系统加密保存 API 密钥；
- 自动检测 Codex / Claude Code 的可执行文件、版本、登录状态和所需安全参数，也允许填写绝对客户端路径及模型名；
- 测试、启用、停用和排序所有后端，删除用户添加的远程 API 后端；
- 查看测试耗时、模型版本、Token 来源和稳定错误码。

API 密钥不会返回给渲染进程，也不会进入模型调用记录、Markdown、SQLite、错误正文或命令行参数。编辑已有 API 后端时留空密钥表示继续使用现有密钥；删除该后端会同时删除对应的加密凭据。停用 CLI profile 不会卸载客户端，也不会退出其账号。

## Codex 与 Claude Code 客户端调用

客户端诊断会检查可执行文件、语义版本号、登录状态和当前版本是否具备全部安全参数。显示“当前版本缺少安全调用能力”时应先更新对应客户端；Decision 不根据猜测的最低版本号放行。

Codex 使用固定的 `exec --ephemeral --json --ignore-user-config` 调用，输出受 JSON Schema 约束，沙箱为只读，批准策略为 `never`。它在一次性空目录中运行，关闭 shell、Web 搜索、Apps、子 Agent 和记忆生成；问题正文只经 stdin 提交，不出现在进程参数中。

Claude Code 使用固定的 print mode、`--safe-mode`、空 `--tools`、`--disallowedTools "mcp__*"`、`--no-session-persistence` 和 `--permission-mode dontAsk`。Decision 不使用 `--bare`，因为需要显式而可验证地关闭工具、MCP、会话持久化与交互授权，同时保留客户端自身认证和网络连接。

两个客户端都：

- 只继承认证、代理、证书、语言和临时目录所需的最小环境；
- 在私有一次性空目录中运行，完成后删除目录；
- 使用无 shell 的绝对可执行路径，并限制 stdout、stderr、超时和响应体积；
- 超时或取消时终止完整进程组；
- 设置 `DECISION_PROVIDER_CHILD=1`。所有 Decision 被动 Hook 在读取 stdin、transcript 或落盘前看到该标记就立即退出，因此不会递归采集模型判断；
- 只保存最终可见结构化结果与服务商报告的 Token，不保存 Codex reasoning 事件、Claude session id 或客户端内部会话。

客户端登录、订阅、额度、模型可用性和服务端数据保留仍由 OpenAI / Anthropic 账号与服务条款决定。“本地客户端”只描述调用入口在本机，不代表推理在本机。

## 本地数据与保留

- `semantic-pair-spool`：保存当前 assistant 文本和下一条用户输入；未配对内容 24 小时过期，已配对未完成内容最多 7 天，路由成功后删除正文。
- `candidate-spool`：中置信候选最多 100 项、默认 7 天；确认前不写 Markdown 或 SQLite。
- `capture-audit`：默认 7 天、最多 5,000 条；只保存阶段、置信档位、耗时、稳定错误码和 HMAC 指纹，不保存正文、cwd、原始会话/轮次 ID、transcript 路径或异常堆栈。
- `model-traces`：默认 7 天、最多 1,000 条；目录 `0700`、单文件 `0600`，每条记录原子写入，损坏文件自动隔离。它可能包含裁剪后的模型输入和可见输出，仅保存在本机 Application Support，不写入 Obsidian、SQLite、iCloud 或 Decision 自建遥测。
- Obsidian Markdown：只有经过理由流程处置的正式决策，仍是唯一事实来源。
- SQLite：正式记录的全文检索和派生状态，可以删除后从 Markdown 重建。

模型输入只包含裁剪后的当前问答对，不包含完整 transcript。Apple 和 Qwen 推理都在本机完成；Qwen 推理不创建网络监听。API 或 CLI 后端只有在用户明确配置并启用后，才把这份裁剪后的 system/user prompt 与输出 Schema 发给所选服务商。服务商是否保留请求由对应账号、端点和服务条款决定；Decision 无法替 OpenAI 兼容服务保证不保留。OpenAI Responses 请求会显式设置 `store: false`，但这不替代服务商自己的数据政策。

## 评估

运行确定性回归报告：

```bash
npm run evaluate:semantic -- --report-only
```

强制质量门槛：

```bash
npm run evaluate:semantic
```

门槛为 high precision ≥ 95%、high + medium recall ≥ 90%。未达到时第二条命令返回非零。报告还包含问答关联准确率、问题/答案原文可定位率、置信混淆矩阵以及语言和客户端切片。

截至 2026-08-13，固定 64 条合成回归集的规则基线为：high precision 100%、high + medium recall 100%、关系准确率 84.4%，问题与答案原文可定位率均为 100%；中文和英文召回均为 100%。31 条 high 标签中有 25 条直接判为 high，6 条只有隐式确认措辞的建议被保守限制为 medium；11 条 medium 和 22 条 low 均保持原档。关系准确率不是路由门槛：剩余差异主要来自信息请求被正确判为 low 后，规则评估器不再继续判断其用户文本是否回答了该信息请求，以及无法仅靠词面确认的改写回答。

显式评估一个已经启用的 Codex / Claude Code profile：

```bash
npm run evaluate:semantic -- --provider builtin-codex --report-only
npm run evaluate:semantic -- --provider builtin-claude-code --report-only
```

这会真实调用所选客户端一次/样本，可能消耗订阅额度或产生费用；不会自动启用 profile，也不会更改设置。报告按 provider 汇总准确率、中位延迟、输入/输出 Token、费用（客户端有报告时）和 Token 不可用次数。API 后端可以把离线预测 JSON 交给 `--predictions` 评估，命令行评估器不会从 Electron 加密存储中提取 API Key。

仓库当前的 64 条完全合成、脱敏语料是实现级回归基线；通过上述门禁只说明这些已知行为没有退化，不等同于产品激活结论。阈值调整和大范围启用前需要至少 500 条按来源、语言和表达类型分层的脱敏标签语料，并用从未参与调参的保留集验收。候选队列中的确认/忽略会成为后续标签来源，但普通对话不会为了评估而长期保存。

查看评估命令帮助：

```bash
node scripts/evaluate-semantic-classifier.mjs --help
```

## 恢复与移除

- **Apple `device_not_eligible`**：不是故障；准备 Qwen 后重启 App，或继续使用规则。
- **`model_missing`**：运行 `npm run prepare:model`。
- **`checksum_failed`**：准备脚本会删除不可信的正式文件并重新下载；不要手工绕过校验。
- **`runtime_unavailable` / 超时**：当前输入自动走另一提供者或规则；30 秒后自动重新探测，也可通过重启 App 立即重新探测。
- **CLI `not_found` / `not_executable`**：在“模型后端”中填写绝对客户端路径；保存后重新测试。
- **CLI `logged_out`**：在原客户端完成登录；Decision 不代管登录。
- **CLI `unsupported`**：更新客户端，直到诊断能找到上述全部安全参数。
- **API `authentication_failed` / `authorization_failed`**：编辑后端并重新填写密钥；旧密钥不会显示。
- **API `rate_limited` / 网络错误**：当前判断继续尝试下一后端；检查账号额度、代理和服务地址后重新测试。
- **中断下载**：保留可信的 `.partial`，再次运行准备命令会续传；长度或哈希异常的 partial 会被删除。
- **移除 Qwen**：先退出 Decision，再删除上面精确路径的 GGUF；生成模型缺失时语义识别自动回到 Apple、其它已启用后端或规则；嵌入模型缺失时决策库和原则召回自动回到关键词。删除模型不会影响 Obsidian Markdown、候选、SQLite 或 Hooks。
- **SQLite 损坏**：在设置页重建；语义 spool 和审计收据不是事实来源。

集成诊断与重装：

```bash
BRIDGE="/Applications/Decision.app/Contents/Resources/bridge/decision-bridge"
"$BRIDGE" install --dry-run
"$BRIDGE" doctor
"$BRIDGE" install --apply
```

重装只替换带 Decision 标识的被动 Hook，并清理历史 MCP，不修改 Claude Code/Codex 的原生询问行为。
