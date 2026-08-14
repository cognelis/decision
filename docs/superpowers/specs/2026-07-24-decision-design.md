# Decision 设计规格

日期：2026-07-24

状态：已确认并实现

首发平台：macOS

实现栈：Electron、TypeScript、React

## 1. 背景

Claude Code 和 Codex 在开发过程中经常要求用户选择方案、确认取舍或决定下一步。用户作出选择后，相关理由通常只存在于对话里，难以积累成可搜索、可复用的方法论。

Decision 在这些显式决策点出现，承载选择和理由追问，并将记录保存到用户现有的 Obsidian vault。未来可以从这些原始记录中提炼原则、工作流和 skills。

## 2. 目标

第一阶段必须实现：

- 同时接入 Claude Code 和 Codex。
- 覆盖所有开发任务中的显式用户决策，不限定 Superpowers 或 Matt Pocock 工作流。
- 展示 LLM 给出的预设选项、推荐项和自定义输入。
- 用户选择后立即询问理由，并允许“稍后补充”或“跳过理由”。
- 用户可以对整个决策选择“不记录”；不记录时仍将选择结果返回给 LLM。
- 用顶部小岛展示简短决策，用展开浮层承载复杂内容。
- Obsidian Markdown 是事实源，SQLite 是可删除、可重建的本地索引。
- App 是唯一持久化写入者。

## 3. 非目标

第一阶段不实现：

- 自动生成知识图谱、方法论、skills 或工作流。
- DuckDB 分析仓库。
- 自动评判决策质量。
- 保存完整聊天记录。
- 云同步、账号系统、远程服务或遥测。
- Windows/Linux 安装包。
- 面向外部分发所需的 Apple notarization 和自动更新。

上述能力可以在原始决策记录稳定后进入第二阶段。

## 4. 产品交互

### 4.1 触发范围

当 LLM 明确要求用户选择、确认取舍或决定执行方向时，应调用 `ask_decision` MCP 工具。LLM 的内部推理和无需用户参与的实现细节不记录。

Hooks 在会话开始时注入这一协议，并对带有显式降级标记的普通文本决策请求作最佳努力的兜底捕获。系统不对任意回答文本做启发式抓取，避免误触发。

### 4.2 小岛与浮层

默认显示在当前屏幕顶部中央：

- 简短问题显示为小岛，可直接选择 2–4 个短选项。
- 内容较长、有方案说明或需要自定义输入时，小岛展开成浮层。
- 浮层显示来源客户端、项目、问题、推荐项、各方案摘要和自定义输入。
- 多个会话同时发起决策时进入 FIFO 队列，并显示来源徽标。

这是一种跨平台可实现的顶部悬浮窗，不依赖 MacBook 刘海，也不承诺与系统灵动岛完全一致。

### 4.3 两步回答

第一步选择：

- 选择预设方案。
- 输入自定义方案。
- 跳过记录后作出选择。

第二步理由：

- 输入自由文本理由。
- 选择预设的理由因素并补充文本。
- 选择“稍后补充”。
- 选择“跳过理由”。

原始理由与未来由 LLM 生成的提炼内容必须分开保存。系统不得把推测写成用户原话。

选择“稍后补充”的记录出现在菜单栏的待补充列表中；第一阶段不主动定时催促。

### 4.4 决策状态

持久化决策使用以下状态：

```text
queued
  -> awaiting_choice
  -> awaiting_rationale
  -> completed | deferred_rationale | rationale_skipped
```

选择“不记录”的决策只存在于内存中，返回结果后立即销毁，不写 Markdown、SQLite 或日志正文。

## 5. 总体架构

```text
Claude Code ─┐
             ├─ MCP / Hooks ─ decision-bridge ─ 本地认证通道 ─ Electron App
Codex ───────┘                                              ├─ Obsidian Markdown
                                                           └─ SQLite 索引
```

采用 TypeScript 单栈 monorepo：

- `apps/desktop`：Electron 主进程、preload 和 React renderer。
- `apps/bridge`：供 Claude Code/Codex 启动的 stdio MCP Server，并提供 hooks 子命令。
- `packages/core`：决策模型、状态机、校验、ID、日期与 Markdown 序列化。
- `packages/protocol`：MCP 输入输出、本地传输协议和版本兼容。
- `packages/storage`：Markdown 事实源和 SQLite 派生索引接口。
- `packages/integrations`：Claude Code、Codex 和平台安装适配器。

模块只通过显式类型和接口协作。Renderer 不直接访问文件系统或数据库。

## 6. 组件职责

### 6.1 Electron App

Electron 主进程负责：

- 维护决策队列和状态机。
- 创建透明、无边框、置顶窗口。
- 运行仅监听 `127.0.0.1` 的本地服务。
- 校验 bridge 请求、执行幂等去重。
- 原子写入 Markdown，并更新 SQLite。
- 监视外部 Markdown 修改并修复索引。
- 保存应用设置和运行时端点信息。

Renderer 只负责展示和收集输入。它加载打包内的本地资源，启用 `contextIsolation` 与 Chromium sandbox，并通过按功能收窄的 preload API 调用主进程。

### 6.2 decision-bridge

`decision-bridge` 是一个可由两个 LLM 客户端按需启动的 Node/TypeScript CLI：

- 使用官方 MCP TypeScript SDK 和 stdio transport 暴露 `ask_decision`。
- 把请求转发给正在运行的 Electron App。
- App 未启动时尝试启动并在有限时间内重连。
- 提供 SessionStart 和 Stop hooks 使用的子命令。
- 不直接写 Markdown 或 SQLite。

安装向导把 bridge 的实际路径注册到 Claude Code 和 Codex，避免依赖全局 npm 或运行时联网下载。MCP 注册调用两个客户端的官方 CLI；hooks 合并到 Claude Code 的 `~/.claude/settings.json` 和 Codex 的 `~/.codex/hooks.json`。

### 6.3 本地通信

App 启动时：

1. 绑定随机 loopback 端口。
2. 生成高熵、单次启动有效的 bearer token。
3. 把端口、token、PID 和协议版本写入当前用户的应用运行目录。
4. bridge 读取运行信息并发起认证请求。

运行信息文件只允许当前用户读取。App 退出后 token 失效。请求必须通过 Zod schema 校验，并带有幂等键。

## 7. MCP 契约

`ask_decision` 的核心输入：

```text
question
context_summary
options[]:
  id
  label
  description
  tradeoffs
recommended_option_id?
allow_custom
source_client
session_id
project
workflow?
decision_type
idempotency_key
```

`context_summary` 只包含理解该决策所需的摘要，不默认发送完整对话、源代码或终端输出。

核心输出：

```text
selected_option_id?
custom_answer?
record_status: recorded | not_recorded
rationale_status: captured | deferred | skipped | not_recorded
rationale?
decision_id?
```

如果用户选择“不记录”，`decision_id` 为空。

## 8. Hooks 策略

### 8.1 SessionStart

为 Claude Code 和 Codex 注入短协议：

- 所有需要用户参与的开发决策优先调用 `ask_decision`。
- 调用失败时回到原客户端提问。
- 不得因为记录工具失败而停止任务。
- 普通文本兜底必须带版本化显式标记。

### 8.2 Stop 兜底

Stop hook 只识别显式降级标记，不做自然语言猜测。捕获成功时把请求送入 App 并等待用户选择，再用 hook 的阻止原因把结果送回下一轮 LLM；捕获失败、格式无效或 App 不可用时允许原问题正常显示。

由于两个客户端的 hook 能力不完全相同，集成适配器分别生成配置，但共享同一协议和测试夹具。Codex 使用独立的用户级 `hooks.json`，避免重写已有 `config.toml`。

## 9. 数据存储

### 9.1 Obsidian Markdown

默认 vault：

```text
$HOME/Documents/Decision
```

默认目录：

```text
Decision Journal/
  decisions/YYYY/MM/
  principles/        # 第二阶段
  workflows/         # 第二阶段
```

每个决策一个 Markdown 文件。YAML properties 保持扁平：

```yaml
id:
created:
status:
source_client:
project:
workflow:
decision_type:
selected_option:
llm_recommendation:
rationale_status:
reason_factors:
tags:
related:
supersedes:
```

正文结构：

```text
# 决策点
## 可选方案
## 我的选择
## 我的理由（原文）
## 当时上下文
## 后续结果
```

文件先写到同目录临时文件，再原子替换目标文件。Markdown 成功即视为事实已保存。

### 9.2 SQLite

SQLite 只保存搜索、过滤、队列恢复和状态查询所需的派生字段。第一阶段使用 Electron 内置 Node 的 `node:sqlite`，并通过 `SqliteIndex` 接口隔离具体实现。

SQLite 更新失败不回滚已成功的 Markdown。App 标记索引需要重建，并在空闲时扫描 Markdown 恢复。用户删除 SQLite 文件不会丢失决策。

第一阶段不同时维护 DuckDB。第二阶段需要跨批次分析时，DuckDB 从 Markdown 或 SQLite 快照导入。

### 9.3 外部编辑

用户可以直接在 Obsidian 中编辑记录。文件监视器按 `id` 和内容指纹更新索引。无法解析的文件保留原样，在 App 中显示诊断，不覆盖用户内容。

## 10. 故障与恢复

- **App 未运行**：bridge 尝试启动 App，并最多等待 5 秒；失败后返回结构化错误，LLM 在原终端继续提问。
- **用户暂时不回答**：MCP 请求可以取消；尚未选择的请求从内存队列移除，不产生持久化记录，也不阻塞其他会话。
- **重复请求**：`idempotency_key` 返回同一个活动决策或已有结果，不创建重复笔记。
- **进程在 Markdown 写入后崩溃**：下次启动扫描事实源并补建 SQLite。
- **SQLite 损坏**：隔离损坏文件，从 Markdown 全量重建。
- **Obsidian/iCloud 暂时不可写**：保留内存中的待提交记录，明确提示用户重试；不谎报保存成功。
- **hooks 失败**：不吞掉 LLM 原始问题，不中断开发流程。
- **协议版本不兼容**：bridge 返回明确升级提示，不尝试猜测字段。
- **多个项目并发**：按到达顺序排队，界面始终显示来源客户端和项目。

App 日志只记录运行状态、错误类别和决策 ID，不记录问题正文、选项或理由。

## 11. 安全与隐私

- 无账号、无云端、无遥测。
- 只加载打包内的本地 UI 资源。
- Renderer 禁用 Node integration，开启 context isolation、sandbox 和限制性 CSP。
- preload 只暴露具体操作，不暴露通用 IPC。
- 本地服务只监听 loopback，并要求单次启动 token。
- 所有跨进程输入都做 schema、长度和枚举校验。
- 默认不存完整对话或源代码。
- “不记录”必须不留下持久化正文或分析索引。

## 12. 平台与分发

第一阶段只构建 macOS arm64 开发版：

- 使用 Electron Forge + Vite 打包。
- 使用 Tray/menu bar 入口和登录启动设置。
- 平台相关能力封装为窗口定位、开机启动、bridge 路径和客户端配置四个适配器。
- 首版可本地运行和安装，不要求 Apple Developer 账号。

对外分发、Developer ID 签名、notarization、自动更新，以及 Windows/Linux 安装器属于后续发布工作。

## 13. 测试策略

### 13.1 单元测试

- 决策状态机的合法与非法转换。
- MCP schema 和协议版本。
- Markdown frontmatter 与正文序列化。
- 幂等键、文件名、日期目录和内容指纹。
- 选择“不记录”时零持久化。
- SQLite 索引映射和重建。

### 13.2 集成测试

- bridge 通过 stdio 接收 MCP 请求并连接测试 App。
- App 使用临时 vault 完成选择、理由、Markdown 和索引全流程。
- Claude Code/Codex hook 的 JSON 输入输出夹具。
- 多客户端并发、排队、取消和重复请求。

### 13.3 恢复测试

- 删除 SQLite 后重建。
- Markdown 已写入但 SQLite 未更新。
- Obsidian 外部编辑、无效 frontmatter 和 iCloud 写入失败。
- App 未运行、启动超时和协议版本不匹配。

### 13.4 UI 与人工验收

- Electron 窗口的小岛、展开、焦点、键盘和多显示器行为。
- 真实 Claude Code 与 Codex 各完成一次 MCP 决策。
- 各完成一次 hooks 降级路径。
- 在 Obsidian 中查看并编辑记录，确认 App 能重新索引。

## 14. 验收标准

- Claude Code 和 Codex 都能调用同一个 `ask_decision` 工具。
- 本地 App 正常运行时，决策请求在 1 秒内进入队列。
- 预设选择、自定义选择、立即理由、稍后理由、跳过理由均能正确返回。
- “不记录”不会产生 Markdown、SQLite 行或正文日志。
- 已记录决策在 Obsidian 中是可读、可编辑的普通 Markdown。
- 删除 SQLite 后可以仅凭 Markdown 恢复完整索引。
- App 或 hooks 故障时，用户仍能在原客户端回答，不阻塞开发。

## 15. 用户需要准备的内容

现在无需准备额外软件、数据库或账号。已自动发现可用的 Obsidian vault，以及满足开发需要的 Node、npm 和 Git。

实施完成后只需要用户：

1. 批准安装程序修改 `~/.claude/settings.json` 和 `~/.codex/hooks.json`，并允许它调用两个客户端的官方 CLI 注册 MCP。
2. 重启 Claude Code 和 Codex，各完成一次真实联调。

只有未来需要把安装包分发给其他人时，才需要 Apple Developer Program 账号和 Developer ID 证书。

## 16. 第二阶段方向

积累足够记录后，再新增独立分析流水线：

- 用 DuckDB 对 Markdown/SQLite 快照做批量分析。
- 提取候选原则，但保留原文引用和人工确认。
- 建立决策、原则、项目、结果之间的知识图谱。
- 从已确认原则生成或更新 skills 与工作流。
- 回填决策后续结果，比较预期与实际。

第二阶段不改变 Markdown 作为事实源的原则。
