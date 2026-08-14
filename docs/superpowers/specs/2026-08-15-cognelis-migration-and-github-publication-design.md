# Cognelis 品牌迁移与 GitHub 开源发布设计

**日期：** 2026-08-15
**状态：** 已批准；用户授权普通实施决策由 Codex 直接确定并记录
**取代：** `2026-08-14-github-open-source-publishing-design.md`

## 目标

在不丢失既有数据和未完成工作的前提下，把工程从历史名称
`Decision Island` 完整迁移为 Cognelis 组织下的 `Decision` 产品，并在全部迁移、
测试和发布审计通过后，以 MIT License 发布到 GitHub。

本次迁移只有两条不可妥协的产品验收标准：

1. 历史沉淀继续可用：既有决策、复盘、方法论、关系、实践资产、版本历史、
   发布历史、设置和模型配置在升级后仍可读取和继续使用。
2. 待处理内容继续可用：待补理由、待确认候选、未配对语义问答、工作箱项目、
   未完成表单与其它尚未落入最终 Markdown 的本地状态在升级后不能丢失、跳过或
   被误标为已经处理。

## 决策授权

普通命名、代码组织、兼容期限、测试拆分和发布细节由 Codex 采用风险最低且维护
成本合理的实现，不逐项请求用户决定。只有以下事项再次请求批准：

- 需要新的账号权限、付费能力或组员 GitHub 用户名；
- 需要删除、覆盖或不可逆移动用户数据；
- 需要上传未签名制品、使用真实发布凭据或改变仓库公开范围；
- 验收标准之间出现无法同时满足的冲突。

## 最终命名体系

`Cognelis` 是组织与发布者品牌，`Decision` 是当前产品。组织名不与单一产品绑定，
以后可以容纳其它知识系统或决策产品。

| 边界 | 新名称 |
| --- | --- |
| GitHub 组织 | `cognelis` |
| GitHub 仓库 | `cognelis/decision` |
| 产品与 App | `Decision` |
| 根 workspace 包 | `@cognelis/decision` |
| 内部 workspace 包 | `@cognelis/decision-core`、`@cognelis/decision-storage` 等 |
| macOS Bundle ID | `com.cognelis.decision` |
| preload API | `DecisionApi`、`window.decision` |
| IPC 前缀 | `decision:*` |
| 环境变量前缀 | `DECISION_*` |
| Hook 标记 | `DECISION_HOOK=` |
| MCP server 名称 | `decision` |
| bridge 可执行文件 | `decision-bridge` |
| Foundation Models helper | `decision-foundation-model-helper` |
| 原生插件 | `decision-liquid-glass.node` |
| 应用数据目录 | `Decision` |
| 新安装默认 Obsidian vault | `Decision Vault` |

新代码、界面、构建输出和正常文档不再产生旧名称。旧名称只允许出现在集中式兼容
模块、兼容入口、迁移测试和本迁移说明中。

## 兼容边界

### 环境变量

建立一个集中式环境变量解析器。每个 `DECISION_*` 变量可以从对应的
`DECISION_ISLAND_*` 变量回退，但新变量始终优先。业务模块只接收解析后的配置，
不能直接读取旧变量。

兼容覆盖运行时路径、测试/冒烟开关、模型子进程标记、Electron 本地制品缓存以及
签名和公证配置。旧变量在整个 `1.x` 系列保持可用，计划在 `2.0` 删除；诊断界面
可以显示正在使用旧覆盖，但不能记录变量值或凭据。

### 应用数据目录

迁移发生在 Electron 设置 `userData`、打开 SQLite、读取凭据或启动任何 spool
消费者之前。

1. 显式设置新或旧 `USER_DATA` 环境变量时，使用该路径，不自动移动默认目录。
2. 未显式设置且只有旧默认目录存在时，在同一父目录内把整个目录原子重命名为
   `Decision`。这会一起保留模型、索引、设置、加密凭据、恢复点和所有待处理目录，
   不复制大型模型，也不暴露半迁移状态。
3. 原子迁移失败时，本次启动继续使用完整的旧目录并提供可重试诊断；不能创建
   新的半成品目录，也不能删除旧目录。
4. 新旧目录同时存在时，新目录是权威目录；旧目录保持不变，应用不做猜测性合并。
   诊断信息说明冲突，后续清理由用户明确触发。
5. 迁移成功后在新目录写入不含正文和凭据的版本标记，记录来源、时间和已完成的
   迁移步骤，使启动过程幂等。

目录迁移只改变容器位置，不改写内容格式。文件权限必须继续满足当前 `0600/0700`
边界。

### Obsidian vault

已经保存的 vault 路径属于用户内容位置，不随品牌迁移自动移动或改名。若旧设置已
指向 `Decision Island Vault`，升级后继续使用它，避免破坏 Obsidian 的 vault 注册、
外部链接和用户工作流。

只有完全没有历史设置的新安装才创建 `Decision Vault`。若设置丢失但旧默认 vault
存在，恢复逻辑先选择旧 vault，再考虑新默认目录，保证历史 Markdown 仍是唯一事实源。

### Hooks、MCP 与 bridge

安装或修复集成时：

- 只删除带 `DECISION_HOOK=` 或 `DECISION_ISLAND_HOOK=` 稳定标记的 App 自有
  handler，保留客户端配置中的未知字段和其它工具；
- 写入新的 `DECISION_HOOK=1` handler 和 `decision-bridge` 路径；
- 幂等移除旧 MCP server `decision-island`，注册新的 `decision` server；
- 打包一个调用同一实现的 `decision-island-bridge` 兼容入口，覆盖整个 `1.x`，
  让 App 首次启动修复 Hooks 之前的旧命令仍可工作；
- bridge 查找运行时文件时优先使用新位置，并在兼容期回退旧位置。

状态检测必须把旧配置识别为“需要升级”，不能把它误报成未安装，也不能在迁移完成
前删除仍然可用的旧入口。

## 历史沉淀验收

历史 Markdown 继续作为决策、方法论、关系和实践资产的事实源；SQLite 继续是可
重建索引。迁移验收使用包含真实结构但脱敏内容的旧版 fixture，迁移前后比较：

- 决策、完整复盘、应用原则和复盘计划的数量及稳定 ID；
- 方法论的候选/采纳/归档状态、证据引用、人工关系和复验游标；
- 实践资产、来源快照、版本历史、发布状态和本地恢复点；
- 设置、vault 路径、模型 profiles、加密凭据文件可访问性与权限；
- SQLite 重建后对 Markdown 的读取结果与迁移前一致。

内容文件不得为了改品牌而重写用户正文、项目名或历史记录中的自然语言。只有 App
拥有的协议标记、目录和配置键属于迁移范围。

## 待处理状态验收

待处理状态不能依赖“以后从 Markdown 重建”，因为其中一部分尚未写入 Markdown。
旧版 fixture 必须覆盖并在升级后继续消费：

- capture spool 中的待补理由与持久化重试项；
- candidate spool 中待确认、待忽略和待重试候选；
- semantic-pair spool 与普通文本 pending 中尚未配对的问答；
- 方法论建议的搁置状态、原则复验工作箱和未完成关系核对；
- 手工方法论、合并和修订表单草稿；
- 尚未完成的实践资产更新、发布或回滚状态。

集成测试必须证明升级前后的待处理总数、稳定标识、顺序和下一处理项相同。任何
无法解析的旧状态都保留原文件并进入可见错误状态，不能静默删除或当作已处理。

## 代码与文档迁移

- workspace 包统一使用 `@cognelis/decision-*`，不使用宽泛的
  `@cognelis/core`，以免阻塞组织内未来产品。
- preload、IPC、结构化模型 schema 名称、临时目录、构建脚本、冒烟夹具和制品名
  全部使用新名称。
- 历史设计文档的产品称谓和文件名迁移为 `Decision`；只有明确讲述兼容边界的文档
  保留旧名称。
- README、发布说明、隐私说明、贡献指南和本地构建步骤面向全新克隆者，不出现
  维护者机器路径或私有基础设施前提。
- 发布可移植性测试增加旧品牌 denylist。测试只允许受控兼容文件中的旧标记，防止
  后续代码再次依赖旧品牌。

## 测试与失败处理

实施按测试先行完成以下验证：

1. 新旧环境变量优先级和完整映射；
2. 仅旧目录、仅新目录、两者并存、迁移失败和幂等重启；
3. 历史沉淀 fixture 的读取一致性与 SQLite 重建；
4. 所有待处理 fixture 的数量、顺序和继续处理能力；
5. 新旧 Hook/MCP 配置的无损幂等迁移；
6. bridge 兼容入口与新运行时位置；
7. fresh install 不创建任何旧名称；
8. 类型检查、完整自动化测试、语义质量门、打包、安装包冒烟和发布制品校验；
9. 凭据、维护者绝对路径、旧品牌正常路径和不应发布制品的静态审计。

失败策略始终保守：迁移失败保持旧状态可用；索引失败从 Markdown 重建；待处理项
解析失败保留原文件；Hooks 写入失败保留原配置并报告。不得用删除旧数据来让测试
通过。

## GitHub 开源发布

全部迁移和验证完成后，通过已登录浏览器创建免费 GitHub 组织 `cognelis`，由当前
账号作为初始 owner。创建公开仓库 `cognelis/decision`：

- 描述：`Local-first macOS platform for capturing, reviewing, and evolving decision rationale.`
- 默认分支 `main`；
- 标准 MIT License，版权归属 `Cognelis contributors`；
- 不使用 GitHub 表单生成 README、`.gitignore` 或 License，避免与已审核文件冲突；
- 等用户提供 GitHub 用户名后，再给组员仓库级 `Write` 或 `Maintain` 权限，不默认
  授予组织管理员权限。

现有 Gitee 历史包含过时个人路径和作者信息，因此保持原样，不推送到 GitHub。
GitHub 使用只包含最终审核树的干净根提交；本地保留原分支与 `origin`，另建
`github-main` 和 `github` remote。

在公开根提交上创建 `v1.0.0` 标签和源码 Release。GitHub Release 明确标记为源码
发布，不上传本地 ad-hoc ZIP；只有 Developer ID 签名、Gatekeeper 和 Apple 公证均
通过的制品才允许作为公开下载附件。

## 发布完成条件

- 两条迁移硬性验收标准都有自动化 fixture 和通过证据；
- fresh install、本地升级、打包 App 冒烟均通过；
- 当前树和干净公开树的秘钥/路径/品牌审计通过；
- GitHub 组织与仓库可公开访问，MIT License 被识别；
- `main` 指向审核后的根提交，`v1.0.0` 精确指向同一提交；
- Release 不含未签名二进制；
- 本地 Gitee 历史和用户工作树未被破坏。
