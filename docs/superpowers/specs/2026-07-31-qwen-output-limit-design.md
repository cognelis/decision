# Decision Qwen 结构化输出截断修复设计

日期：2026-07-31

状态：已确认，待实现

## 1. 背景

Qwen 本地模型的语义分类固定使用 256 个输出 Token。现场调用记录中出现大量
`invalid_output`，诊断均为 JSON 字符串未闭合。对两条真实失败记录的重放证明：

- 截图对应样本在第 655 个字符处停止，恰好消耗 256 个输出 Token；
- 另一条样本稳定在第 490 个字符处停止，同样恰好消耗 256 个输出 Token；
- 将后一条样本的预算提高到 512 后，JSON 正常闭合，实际消耗 326 个输出 Token。

当前生成 Schema 没有限制 `question`、`answerExcerpt` 和单个 `optionLabels`
的长度。模型会复制较长原文，因而在 JSON 闭合前撞上 256 Token 上限。

## 2. 目标

- 让当前真实失败样本生成可解析、符合 Schema 的 JSON；
- 约束模型复制字段，避免输出长度随输入正文无界增长；
- 区分“模型输出格式错误”和“输出预算耗尽”；
- 在失败调用记录中保留实际 Token 用量；
- 保持现有超时、后端顺序、规则降级和隐私边界不变。

## 3. 方案比较

### 3.1 只把输出预算提高到 512

改动最小，但复制字段仍然无界。更长输入仍可能把 JSON 截断，错误也仍会被误报为普通
`invalid_output`。不采用。

### 3.2 限制复制字段、提高预算并记录预算耗尽

在生成 Schema 中限制复制字段，同时把 Qwen 输出预算提高到 512。若 JSON 解析失败且
Token 计数已经达到预算，记录 `output_limit` 及实际用量。该方案直接处理两个已确认根因，
不改变分类与路由协议。采用。

### 3.3 移除模型的结构提取字段

模型只返回意图、关联和置信度，问题、选项与答案完全由确定性代码提取。长期边界更清晰，
但会削弱模型对规则漏召回样本的结构建议，并扩大本次修复范围。留作后续独立设计。

## 4. 详细设计

### 4.1 生成边界

统一语义生成 Schema 使用以下上限：

- `question.maxLength = 160`；
- `answerExcerpt.maxLength = 120`；
- `optionLabels.items.maxLength = 80`；
- `optionLabels.maxItems = 8` 保持不变。

这些边界覆盖当前成功 Qwen 记录的观测最大值，并留有余量。应用侧仍会执行现有的原文包含
校验；模型生成的字符串不能成为新的事实来源。

Qwen 的 `maxTokens` 从 256 提高到 512。长度约束负责控制正常输出，512 只作为闭合 JSON
的安全余量，不鼓励模型生成更长正文。

### 4.2 错误分类

Qwen 在提示前后读取 runtime token meter。若 JSON 解析失败，且本次输出 Token 增量达到
512，则抛出 `output_limit`，诊断明确说明输出在闭合有效 JSON 前耗尽预算。

若 Token 计数不可用或未达到上限，继续使用 `provider_invalid_output`，保留真实的 JSON
解析诊断。`output_limit` 在模型调用记录中沿用 `invalid_output` 状态，但使用独立错误码，
设置页显示“输出达到长度上限”。

`capture-audit` 保持粗粒度的 `provider_invalid_output`，避免为提供者内部细节改变无正文
审计协议。

### 4.3 失败 Token 记录

`QwenProviderError` 携带已经归一化的 Token 用量。模型网关记录失败 attempt 时优先使用该
用量；没有可靠计量的其它错误仍记录 `source: "unavailable"`。

不保存失败时的原始未闭合输出，保持现有内容边界。诊断只记录稳定错误原因和 Token 上限。

### 4.4 降级与重试

本次不增加自动重试。Qwen 达到输出上限后按现有模型网关顺序尝试下一后端，最终仍可退回
规则。这样避免同一 2B 模型重复生成带来的额外延迟。

## 5. 测试

测试先行覆盖：

1. 生成 Schema 对问题、答案和选项执行上述长度限制；
2. Qwen 调用使用 512 个输出 Token；
3. runtime 返回 512 Token 的未闭合 JSON 时产生 `output_limit`，并携带实际 Token 用量；
4. 未达到 Token 上限的坏 JSON 仍产生 `provider_invalid_output`；
5. 两个模型网关将 `output_limit` 记录为 `invalid_output` 状态、独立错误码和
   `runtime_measured` 用量；
6. 设置页为 `output_limit` 显示明确中文说明；
7. 使用本机真实 Qwen 权重重放截图样本，确认不再产生未闭合 JSON。

完成定向测试后运行完整测试、类型检查、语义基线、发布构建和打包后冒烟验证。

## 6. 非目标

- 不修改模型后端排序或启停配置；
- 不改变 Apple、API 或 CLI 提供者的 Token 预算；
- 不自动修补或猜测未闭合 JSON；
- 不改变决策事实、Markdown 或 SQLite 的数据模型；
- 不借本次修复调整语义分类阈值。
