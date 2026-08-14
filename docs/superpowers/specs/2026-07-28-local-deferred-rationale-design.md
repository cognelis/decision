# Decision 本地稍后处理设计

日期：2026-07-28
状态：已确认

## 背景

当前理由页的“稍后处理”提交 `deferred` 状态。`CaptureRuntime` 把除“不记录”之外的
所有状态都交给 `DecisionStore.save`，因此立即在 Obsidian 中创建
`deferred_rationale` 笔记、更新 SQLite，然后确认并删除本地捕获。

这与产品语义不符。“稍后处理”表示用户尚未完成对该决策的记录，不应提前进入作为
唯一事实来源的 Obsidian。

## 目标

- “稍后处理”只进入 Decision 的本地待补理由队列。
- 稍后状态不写 Obsidian Markdown，也不更新 SQLite。
- 待补理由跨 App 重启恢复。
- 用户最终补充理由、跳过理由或选择不记录时，才完成正式处置。
- 保持已有 `deferred_rationale` Markdown 的读取和补充能力。
- 不改变 Claude Code、Codex 的原生交互和被动 Hook 行为。

## 非目标

- 不自动删除或迁移已经写入 Obsidian 的历史 `deferred_rationale` 笔记。
- 不引入 DuckDB、新数据库或新的事实来源。
- 不增加决策历史中心、批量编辑或自动过期功能。
- 不改变“待处理”语义候选队列；本设计只处理已经确认、正在等待补充理由的决策。

## 1. 产品语义

### 1.1 稍后处理

点击“稍后处理”后：

1. 当前问题、答案、上下文及 `deferred` 标记写入仅当前用户可读的本地
   `capture-spool`。
2. 当前理由岛关闭或继续显示队列中的下一项。
3. 设置页“待补理由”立即出现该项。
4. Obsidian 和 SQLite 保持不变。

稍后处理不是正式决策状态，也不是“不记录”。它只是尚未完成的本地工作项。

### 1.2 最终处置

本次修复保持设置页现有范围：用户从“待补理由”补充理由后，才生成正式 Markdown、
写入理由原文并更新 SQLite。

“跳过理由”和“不记录”仍可在首次理由页直接选择。本次不为已经选择稍后处理的项目
新增这两个设置页操作；如后续需要，可在不改变本地 spool 数据模型的前提下扩展。

## 2. 数据模型

### 2.1 本地待补状态

继续复用 `capture-spool` 的两个现有文件：

- `events` 保存完整受限捕获事件；
- `dispositions` 保存 `{ "status": "deferred" }`。

提交稍后处理时不写确认回执，因此事件正文不会被清除。App 启动后同时读取事件与
`deferred` 标记，恢复为本地待补项，而不是重新弹出理由岛。

不使用 SQLite 保存待补正文或主状态。SQLite 仍只索引已经写入 Markdown 的正式记录。

### 2.2 稳定标识

本地待补项继续使用确定性的决策 ID：

```text
decision-<rationaleCandidateKey>
```

该 ID 用于设置页操作、跨重启恢复以及最终 Markdown 文件名。它不代表 Markdown 已经
存在。

### 2.3 内存投影

`CaptureRuntime` 维护本地待补项的内存投影，内容来自：

- 当前会话新提交的 `deferred`；
- 启动时从 `capture-spool` 恢复的 `deferred`。

`pendingRationales()` 合并：

1. 本地 spool 待补项；
2. SQLite 中已有的历史 `deferred_rationale` 笔记。

按创建时间排序并按决策 ID 去重。这样旧记录仍可补充，新记录不依赖 SQLite。

## 3. 数据流

### 3.1 新的稍后处理

```text
理由页提交 deferred
  -> 保存 disposition 恢复标记
  -> 加入本地待补投影
  -> 不调用 DecisionStore.save
  -> 不写语义完成回执
  -> 不确认 capture-spool 事件
  -> RationaleQueue 进入下一项
```

保留原始事件才能在最终处置时创建完整 Markdown，并防止 App 重启后丢失上下文。

### 3.2 启动恢复

```text
读取 capture-spool events
  -> 读取每个问题的 disposition
  -> deferred：恢复到本地待补投影，不进入活动理由队列
  -> captured / skipped / not_recorded：
       继续现有崩溃恢复流程
  -> 无 disposition：进入活动理由队列
```

恢复判定应发生在活动队列入队之前，避免启动时短暂弹出已经选择稍后处理的项目。

### 3.3 补充理由

```text
设置页提交补充理由
  -> 先定位本地待补项
  -> 将 disposition 原子替换为 captured
  -> 创建并保存正式 DecisionRecord
  -> Markdown 成功后更新 SQLite
  -> 写语义完成状态和捕获确认回执
  -> 删除 event / disposition 正文
  -> 从本地待补投影移除
```

如果 ID 不属于本地待补项，则继续调用现有 `completeDeferredRationale`，完成历史
Markdown 草稿。

## 4. 失败与恢复

### 4.1 保存稍后状态失败

- 当前理由项保持在页面中；
- 显示现有持久化失败与重试状态；
- 不进入待补投影；
- 不写 Markdown，也不确认捕获事件。

### 4.2 最终 Markdown 写入失败

- 保留原始事件和 disposition；
- 本地待补项继续显示；
- 不写捕获确认回执；
- 用户可重试；
- 如果 disposition 已先变为 `captured`，下次启动沿用现有崩溃恢复流程继续保存。

### 4.3 SQLite 更新失败

- Markdown 成功即视为正式记录已保存；
- 清理本地待补正文；
- 保持现有索引降级提示和重建能力。

### 4.4 损坏文件

沿用 `capture-spool` 的隔离与恢复告警。损坏的 disposition 不得导致原始 event 被删除；
无法确认状态时保留事件并提示恢复异常。

## 5. 去重与队列

- 稍后处理不生成“已完成”语义回执。
- 同一会话内的重复捕获仍由 `RationaleQueue` 的 candidate key 和语义键去重。
- 跨重启时，带 `deferred` disposition 的事件只恢复为一个本地待补项。
- 本地待补完成后才写现有语义完成回执及 capture acknowledgement。
- 连续“待处理”会话中的提升项选择稍后后，自动返回下一项；该项同时出现在设置页
  “待补理由”中。

## 6. 兼容性

已有 Markdown：

- 保留 `deferred_rationale` 和 `rationale_status: deferred` 的解析与索引；
- 设置页继续显示并允许补充；
- 不自动删除、迁移或改写用户已有文件。

新版本创建的本地待补项：

- 不产生 `deferred_rationale` Markdown；
- 完成后直接产生 `completed` Markdown；
- 不与同 ID 的历史 Markdown 重复显示。

## 7. 测试与验收

### 7.1 单元与集成测试

- 提交 `deferred` 后 `DecisionStore.save` 未调用。
- 提交 `deferred` 后 event 和 disposition 保留、无 acknowledgement。
- 本地待补项立即出现在 `pendingRationales()`。
- App 重启后本地待补项恢复且不进入活动理由队列。
- 补充本地待补理由后只创建一条正式 Markdown，并清理 spool。
- Markdown 保存失败时待补项和正文保持可重试。
- SQLite 失败不回滚已保存 Markdown。
- 历史 `deferred_rationale` 仍能通过原路径完成。
- 本地与历史项按 ID 去重。

### 7.2 产品验收

1. 触发一条理由采集并点击“稍后处理”。
2. 确认 Obsidian 没有新增笔记、SQLite 记录数不变。
3. 确认设置页“待补理由”出现该项。
4. 重启 App，确认该项仍存在且不会自动弹出理由岛。
5. 补充理由，确认此时才生成一条正式 Markdown。
6. 再次重启，确认待补项已消失且不会重复记录。
