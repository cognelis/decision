# Decision 被动 Hook 采集设计

日期：2026-07-25  
状态：已确认  
目标形态：原生问答不变，Hook 旁路采集，Decision 独立追问理由

## 1. 背景与修正

当前版本通过 `ask_decision` MCP 工具承接选择，并用 `SessionStart` 指令要求
Claude Code 和 Codex 优先调用该工具。Stop hook 只在模型输出显式降级标记时接管
请求。这套实现把 Decision 放进了 Agent 的控制路径，改变了客户端原本的
提问方式，也让 App 故障可能影响一次决策的完成。

产品原始需求不是替换 Claude Code 或 Codex 的原生提问，而是通过 hooks 被动记录
已经发生的问题和回答。原生客户端应继续负责展示问题、收集选择和把答案返回给
Agent。Decision 只在原生回答完成后接收副本，独立收集理由并写入本地知识
库。

本设计替代原规格中关于 `ask_decision` MCP、`SessionStart` 行为指令、显式 Stop
降级协议和 App 内选择步骤的集成方向。Markdown 事实源、SQLite 派生索引、本地
优先、安全边界和理由记录原则继续保留。

## 2. 目标

- Claude Code 和 Codex 的原生提问 UI、工具选择和执行顺序完全不变。
- Hook 在原生结构化问题成功回答后复制问题、选项和答案。
- Hook 不阻断、不改写、不注入上下文；App 故障不影响 Agent 继续工作。
- 每个问题形成一条独立候选决策，同批多个问题保留批次关系。
- 原生回答后立即显示理由岛，同时 Agent 在原客户端继续执行。
- 用户可以填写理由、稍后处理、跳过理由或不记录此次决策。
- “稍后处理”立即写入 Markdown，并进入可恢复的待补理由队列。
- 第一阶段可靠采集结构化提问；第二阶段在同一管道上增加普通文本问答兜底。
- 所有业务事实最终仍以人类可读、可编辑的 Obsidian Markdown 保存。

## 3. 非目标

- 不替换或劫持 `AskUserQuestion`、`request_user_input` 或其它原生提问能力。
- 不要求 LLM 知道 Decision，也不通过提示词改变其工具调用习惯。
- 不把 Hook 变成审批、策略执行或会话阻断机制。
- 不保存完整聊天记录。
- 不依赖云端模型判断一条问答是否值得记录。
- 不在本阶段实现决策回顾中心、统计、知识图谱或自动生成 Skills。
- 不引入 DuckDB。

## 4. 用户体验

### 4.1 原生选择

Claude Code 或 Codex 按原有流程展示问题。用户在原生界面完成单选、多选、自定义
答案或其它受支持的回答。原生客户端立即把答案返回给 Agent，Agent 无需等待
Decision。

Decision 不显示选择页，也不向原生客户端回传答案。

### 4.2 理由岛

成功捕获回答后，Decision 把每个问题加入 FIFO 理由队列。队首立即显示
理由岛：

- 显示来源客户端、项目、原始问题和原始答案；
- 允许选择现有判断依据因素；
- 允许输入自由文本理由；
- 保存原始选项供 Markdown 与后续回顾使用；当前理由岛只读展示原问题和答案，
  不提供返回、重选或修改入口；
- 保留“不记录此次决策”复选框，不改成 switch。

可执行四种处置：

1. **完成记录**：保存答案、判断依据和理由，状态为 `completed`。
2. **稍后处理**：保存答案，理由状态为 `deferred`，进入待补理由队列。
3. **跳过理由**：保存答案并明确标记理由已跳过。
4. **不记录**：丢弃候选事件，不创建 Markdown 或 SQLite 记录。

处置当前问题后继续显示同一批次或其它会话的下一条候选。不同会话并发捕获时按
到达顺序排队。

### 4.3 多问题调用

原生工具一次可包含多个问题。每个问题单独生成候选和 Markdown 记录，便于搜索、
复盘和提炼；所有记录共享 `batch_id`，并保存 `question_index`。理由岛在同一个
窗口中逐条处理，不创建多个并行窗口。

### 4.4 App 未运行

Hook 先把事件原子写入仅当前用户可读的暂存队列，再尝试将事件发送给 App。App
未运行时，Hook 以非阻塞方式请求系统后台启动 App 并立即成功退出。App 启动后
重放暂存队列并显示理由岛。

暂存事件不是已接受的决策事实。完成、稍后或跳过后，事件被转换成 Markdown；
选择不记录后，事件正文从暂存队列删除。

## 5. 分阶段交付

### 5.1 第一阶段：结构化工具采集

第一阶段只处理原生结构化提问工具的成功结果：

- Claude Code：`PostToolUse` 匹配 `AskUserQuestion`；
- Codex：客户端发布工具生命周期事件时，`PostToolUse` 匹配
  `request_user_input`，并兼容客户端实际暴露的等价工具名称。

Hook 输入已经包含结构化问题、选项、工具调用标识和工具结果。适配器只复制必要
字段，规范化后提交到统一采集管道。取消、失败或没有答案的工具调用不创建候选。

### 5.2 第二阶段：Stop/transcript 兼容与普通文本问答兜底

第二阶段增加 `Stop`、`UserPromptSubmit` 和本地 transcript 的局部解析：

1. 若 Codex 的原生 `request_user_input` 未发布 `PostToolUse`，Stop 从受限
   transcript 尾部配对同一 turn 内所有完整的工具调用和成功回答；
2. 每个配对结果复用结构化适配器，保持工具调用标识、问题、选项和答案语义；
3. Stop 仍独立检查可能面向用户的最后一个直接文本问题，不因同 turn 已恢复
   结构化结果而跳过；
4. 下一次 UserPromptSubmit 只与同一 session/turn 的待匹配文本问题关联；
5. 普通文本优先使用 hook 直接提供的消息字段，只有字段不足时才读取 transcript
   中紧邻事件的最小窗口；
6. transcript 读取上限为尾部 64 KiB；跨 turn、未配对、取消、失败或格式不完整的
   工具记录全部放弃；
7. 在本机提取候选后立即丢弃无关文本，不向 App 发送完整 transcript。

恢复出的结构化候选和普通文本候选进入相同的理由队列、持久化和去重流程。第二阶段
不修改第一阶段的数据模型、UI 或存储接口。

为了减少误判，文本兜底只接受最后一条明确要求用户回答的直接问题。状态汇报中的
反问、修辞问句、代码注释和引用内容不生成候选。无法确定问题与回答关系时放弃
捕获，原会话始终正常继续。

## 6. 总体架构

```text
Claude Code ─ PostToolUse / Stop / UserPromptSubmit ─┐
                                                     ├─ hook bridge
Codex ─────── PostToolUse / Stop / UserPromptSubmit ─┘
                                                            │
                                              private spool + local delivery
                                                            │
                                              capture ingestion service
                                                            │
                                      validate → normalize → deduplicate
                                                            │
                                                rationale FIFO queue
                                                            │
                              ┌─────────────────────────────┴─────────────┐
                              │                                           │
                       Obsidian Markdown                           SQLite index
                       unique source                              rebuildable
```

### 6.1 Hook adapters

每个客户端使用自己的 payload 适配器，输出共享的
`CapturedDecisionEvent`。适配器不拥有业务状态，不直接写 Markdown，也不等待
用户输入。

### 6.2 Hook bridge

现有 bridge 保留为打包内的本地 CLI，但职责从 MCP Server 改为：

- 接收 hook JSON；
- 严格校验大小和必要字段；
- 原子追加到私有暂存队列；
- 尝试向正在运行的 App 发送事件；
- 必要时后台启动 App；
- 无论 App 状态如何，都在短超时内以成功状态结束。

bridge 不再注册 MCP 工具，也不向 Agent 输出 Decision 指令。

### 6.3 采集服务

Electron 主进程中的采集服务负责：

- 校验事件版本和来源；
- 把客户端 payload 规范化为独立问题；
- 计算稳定去重键；
- 合并暂存重放与实时投递；
- 维护理由 FIFO；
- 将用户处置交给存储层；
- 确认处理完成后清理暂存正文。

Renderer 仍只通过窄 preload API 获取当前候选并提交理由，不读取 hook 文件或
SQLite。

### 6.4 存储层

候选在用户处置前只存在于私有暂存队列和 App 内存。用户选择完成、稍后或跳过后，
`DecisionStore` 创建正式 `DecisionRecord` 并写入 Markdown，再更新 SQLite。

SQLite 继续承担全文检索、待补理由、内容指纹和状态索引。删除 SQLite 后可完全
从 Markdown 重建。

## 7. 统一采集事件

共享事件使用版本化 envelope，至少包含：

```text
event_version
capture_mode: structured_tool | transcript
source_client: claude-code | codex
session_id
turn_id?
source_event_id?
tool_use_id?
batch_id
project
cwd
captured_at
questions[]
```

每个问题包含：

```text
question_index
header?
question
options[]:
  id?
  label
  description?
answer:
  kind: preset | multiple | custom
  values[]
multi_select
```

正式决策记录新增来源字段：

```text
capture_mode
source_event_id
batch_id
question_index
```

`question`、选项和答案保存原文。理由仍分为用户原文和结构化判断依据，不把程序
推测写成用户原话。

## 8. 去重与顺序

优先使用客户端提供的稳定事件 ID：

```text
source_client + session_id + tool_use_id + question_index
```

缺少稳定 ID 时，使用：

```text
source_client + session_id + turn_id + normalized question + normalized answer
```

的 SHA-256 指纹。实时投递和暂存重放共享同一个去重存储。相同事件只进入理由队列
一次。

队列顺序以 App 首次接收时间为准；同批问题按 `question_index` 排序。重启后从
暂存事件恢复原顺序。

## 9. 安装与迁移

设置页的“预览变更”必须展示以下迁移：

- 移除 Decision 自己注册的 Claude Code 和 Codex MCP；
- 移除带 Decision 标识的旧 `SessionStart` 和 `Stop` hooks；
- 安装新的 `PostToolUse`、`Stop` 和 `UserPromptSubmit` 被动 hooks；
- 保留用户和其它工具已有的 MCP、hooks、顺序和未知字段；
- 配置写入前继续生成相邻时间戳备份。

第一阶段可以先安装 `PostToolUse`，同时把第二阶段事件配置置于功能开关之后；最终
启用混合采集时不需要再次改变正式决策数据模型。

集成状态检测改为检查被动 hooks，不再以 MCP 是否注册作为“已连接”的条件。

## 10. 故障处理

- **App 不可用**：事件保留在私有暂存队列，Hook 成功退出，Agent 继续。
- **后台启动失败**：不向原客户端显示错误；设置页显示待交付事件和健康状态。
- **Hook payload 无效**：丢弃该事件并记录无正文诊断，绝不阻塞会话。
- **重复投递**：去重后确认，不重复弹窗或写笔记。
- **原生工具取消或失败**：不生成已回答候选。
- **Markdown 写入失败**：候选和用户理由保留，理由岛显示重试保存。
- **SQLite 更新失败**：Markdown 成功即视为事实已保存，索引标记需要重建。
- **暂存文件损坏**：隔离损坏文件，保留可解析事件并显示健康告警。
- **Transcript 格式变化**：停止该客户端的文本兜底，结构化采集继续工作。

业务正文不得写入普通运行日志。暂存文件、Markdown、SQLite 及 sidecar 都只能由
当前用户读取。

## 11. 兼容与清理

实现完成后删除不再使用的：

- `ask_decision` MCP server 和协议请求/结果；
- App 内“等待选择”和答案回传链路；
- SessionStart 协议文本与显式 Stop 标记解析；
- MCP 安装、检测和医生检查分支；
- 仅服务旧选择页的 UI 和状态。

仍可复用：

- 来源徽标、理由因素、理由输入、稍后和跳过交互；
- Markdown repository、SQLite index、外部文件 watcher；
- App 本地认证通道和运行描述文件；
- 安装预览、配置备份和设置健康状态。

迁移代码只处理 Decision 自己拥有、带稳定标识的配置，不能按事件名称批量
删除用户 hooks。

## 12. 测试策略

### 12.1 Hook 契约测试

- Claude Code 单问题、多问题、单选、多选、自定义和取消 payload。
- Codex 单问题、多问题、自定义和失败 payload。
- Hook 在 App 运行、未运行、超时和拒绝连接时都快速成功退出。
- stdout 不注入上下文，退出结果不包含 block、decision 或 updated input。
- 不读取或发送与候选无关的会话正文。

### 12.2 采集与队列测试

- 多问题拆分并共享 batch ID。
- 实时投递与暂存重放去重。
- 多客户端并发保持 FIFO。
- App 重启恢复未处理候选。
- 不记录、完成、稍后和跳过四种处置。
- 多选和自定义答案保持原文。

### 12.3 存储与恢复测试

- 正式记录包含 capture mode、来源事件和批次关系。
- 稍后处理创建可重建的待补理由记录。
- 不记录后没有 Markdown、SQLite 或暂存正文。
- Markdown 成功、SQLite 失败时仍正确确认事实保存。
- 删除 SQLite 后从 Markdown 恢复完整索引。

### 12.4 Transcript 兜底测试

- Stop 与下一次 UserPromptSubmit 在同一 session/turn 正确关联。
- 结构化事件和 transcript 候选不会重复。
- 修辞问句、引用、代码和状态汇报不生成候选。
- transcript 缺失、截断或格式不兼容时安全放弃。
- 解析器只读取事件附近的最小窗口。

### 12.5 安装迁移与端到端测试

- 预览和应用迁移只删除 Decision 旧配置。
- 用户已有 MCP、hooks 和未知字段原样保留。
- 打包后的 App 通过真实 bridge 夹具接收 hook 事件。
- 原生工具回答不等待 App。
- 结构化问答到理由、Markdown 和 SQLite 的完整冒烟流程通过。
- 全量单元测试、类型检查、macOS 打包和冒烟测试通过。

## 13. 验收标准

- Claude Code 和 Codex 不再注册或调用 `ask_decision`。
- 两个客户端不再接收 Decision 的行为指令。
- 原生结构化提问与回答流程在 App 关闭时仍完全可用。
- 每个成功回答的问题只产生一个候选，且不延迟 Agent。
- 理由岛只收集理由，不允许改变已提交的原生答案。
- 稍后处理可以跨 App 重启恢复并补充。
- 不记录最终不留下候选正文或正式记录。
- 最终混合采集同时覆盖结构化工具和满足精确规则的普通文本问答。
- 完整 transcript 不进入 App、Markdown、SQLite 或普通日志。
- Markdown 继续是唯一事实来源，SQLite 可以随时删除并重建。
