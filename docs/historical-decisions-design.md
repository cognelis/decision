# 历史决定（Historical Decisions）设计方案

日期：2026-11-21。状态：设计稿经用户确认（2026-11-21「通过，开始实现」），已实现（IMP-207）；变更历史界面与遗留问题的处理见 IMP-208。实现记录见第 8 节。

## 1. 背景与定位

Paraself 当前的「决策记录（Decision Record）」默认绑定完整的沉淀与复盘闭环：缺少理由会进入首页「待补理由」，命中选型/架构/发布规则会自动安排 14 天复盘，并参与 `search_decision_context`、决策分析与方法论提炼。

但在日常工作与个人选择中，存在大量**只需留档以便事后追溯的决定**：当时已经拍板，之后偶尔需要回头查“什么时候定了什么、备选过什么、替代了之前的哪个决定、现在还算不算数”，但没有必要为此写论证理由、做 14 天复盘，也不希望这些缺少理由与边界的记录混入 `search_decision_context` 稀释日常编码/评审时的决策召回质量。

因此新增独立的轻记录类型 **历史决定（`historical_decision`）**：

- **核心定位**：面向人（及明确要求追溯时的 Agent）的决定台账 / 事实留档，重在**低摩擦录入**与**事后可追踪**。
- **与「仅本机保留」的关系**：先独立存在，不改动「仅本机保留」作为采集暂存整理箱的语义；后续视实际使用情况再决定是否合并。
- **严格隔离边界**（不进入以下流程）：
  - 不进入 `search_decision_context`（包括关键词与语义向量检索）与 `consult_decision_principles`；
  - 不进入首页「待补理由」与 14 天自动复盘队列；
  - 不进入「整理与记忆（Organization）」、方法论提炼（Methodology）与决策分析（Analytics）的理由完整率统计。
- **单向升级通道**：日后若发现某条历史决定值得补充理由、跟踪结果并参与检索，可在详情页一键「转为正式决策」，保留双向关联（`promotedDecisionId`）。

## 2. 领域术语（待同步至 `CONTEXT.md`）

**历史决定（Historical Decision）**：
一次已经作出的选择或拍板的事实留档，记录决定了什么、何时决定、当时背景与演化关系，便于日后追踪。它不要求填写理由，不进入自动复盘、方法论沉淀与 `search_decision_context` 默认检索；需要沉淀时可单向转为正式决策。
_Avoid_：决策日志（易与设置中的「日志」混淆）、本机记录（易与「仅本机保留」混淆）

## 3. 字段设计

录入时仅 **`title`（决定事项）** 与 **`decision`（最终决定）** 必填，`decidedOn` 默认今天；其余字段全部选填，不催补、不标缺项。

### 3.1 核心事实

| 字段 | 必填 | 类型 / 约束 | 说明 |
| --- | --- | --- | --- |
| `title` | 必填 | 单行文本（1–500 字） | 决定事项 / 针对什么事拍板 |
| `decision` | 必填 | 多行文本（1–8000 字） | 最终决定 / 实际选了什么方案或结论 |
| `decidedOn` | 默认今天 | `YYYY-MM-DD` | 拍板日期；补记过去决定时可直接修改 |

### 3.2 追踪上下文（全选填）

| 字段 | 类型 / 约束 | 说明 |
| --- | --- | --- |
| `options` | `string[]`（≤8 项，每项 ≤500 字） | 当时考虑过的备选方案，不要求写优缺点论证 |
| `context` | 多行文本（≤8000 字） | 当时的客观背景与约束（工期、人力、阶段等），不是理由论证 |
| `project` | 单行文本（≤500 字） | 所属项目或仓库 |
| `scope` | 单行文本（≤500 字） | 比项目更细的影响范围（模块、服务、业务线、版本号等） |
| `participants` | `string[]`（≤12 项，每项 ≤100 字） | 参与方 / 拍板人（如 `个人`、`前端组`、`产品-张三`） |
| `sourceKind` | 枚举（默认 `app_manual`） | `app_manual` / `meeting` / `offline_conversation` / `pr_comment` / `agent_capture` |
| `reversibility` | 可选枚举 | `easy`（易回退）/ `costly`（改动成本高）/ `irreversible`（难逆转） |
| `references` | `{ url, label? }[]`（≤8 条） | 相关外部链接（PR、RFC、工单、文档等，HTTPS 或 loopback HTTP，无凭据） |
| `relatedNotes` | `string[]`（≤8 条，每项 ≤300 字） | 关联的 Obsidian 笔记（相对路径或 `[[笔记名]]`），方便 Vault 内跳转 |
| `tags` | `string[]`（≤12 项，每项 ≤100 字） | 分类/主题标签（如 `选型`、`排期`、`临时妥协`） |
| `notes` | 多行文本（≤8000 字） | 自由备注区（可顺手放任何零散信息，绝不标「缺理由」） |

### 3.3 演化与状态追踪

| 字段 | 类型 / 约束 | 说明 |
| --- | --- | --- |
| `status` | 枚举（默认 `active`） | `active`（有效）/ `superseded`（已替代）/ `ended`（已结束）/ `withdrawn`（已撤回） |
| `supersedesId` | `string \| null` | 指向被本条替代的旧历史决定 ID；拒绝环路；详情页展示双向演化链 |
| `statusNote` | 多行文本（≤1000 字） | 状态变更时的简短说明（如「v2.0 重构后不再适用」） |
| `revisitCondition` | 单行文本（≤500 字） | 静态备忘：什么前提变化时值得重看，**不**触发自动复盘提醒 |
| `promotedDecisionId` | `string \| null`（系统写入） | 一键「转为正式决策」后保留的正式决策 ID |
| `id` / `createdAt` / `updatedAt` / `revision` | 系统维护 | 稳定 ID（如 `hdec-...`）、时间戳与递增版本号（乐观锁） |

## 4. 存储设计：Obsidian + SQLite

### 4.1 Obsidian Markdown（事实源）

- 目录：`Decision Journal/history/YYYY/<decidedOn>-<slug>-<shortId>.md`，单条一笔记。
- YAML Frontmatter 保存全部结构化属性（`type: historical-decision`、`version: 1`、`id`、`title`、`decided_on`、`status`、`project`、`scope`、`participants`、`source_kind`、`source_client`、`reversibility`、`tags`、`related_notes`、`supersedes`、`status_note`、`revisit_condition`、`promoted_decision_id`、`revision`、`created`、`updated`），兼容 Obsidian Bases / Dataview。
- 正文使用受控注释标记（`<!-- decision:history-decision-start -->` 等）管理最终决定、备选方案、当时背景、相关链接、补充备注；空字段不输出空标题；用户在 Obsidian 中额外手写的段落原样保留（复用 `note-rewrite.ts` 的原子写入）。

### 4.2 SQLite（独立本地索引 + 变更历史）

- 独立表 `historical_decisions`（不写入现有 `decisions` 表与语义向量索引），缓存检索字段与正文哈希，支持按关键词、项目、日期区间、标签、状态、可逆性快速筛选与分页；索引可随时从 Vault 全量重建。
- 独立变更历史表（沿用 `todo-history.ts` 模式），在本机记录每次字段修改、状态切换、撤回与转正的时间、来源与变更摘要，保持 Obsidian 笔记清爽。

## 5. 界面范围与设计稿

统一设计稿：[Paraself 设计](https://claude.ai/artifact/CsaWzJMXPFhNHPNEGJuw23)，新增页面 **「历史决定」**，主窗口尺寸 `1160×760`，视觉变量严格沿用 `apps/desktop/src/renderer/styles.css`（中性灰窗口 `#eef0f3`、白底工作面 `#ffffff`、发丝线 `#e3e6eb`、紫色主题预设 `#8b2fc9` 仅用于主操作与激活态）。

包含 4 张画板：

1. **知识 › 历史决定列表**：知识页新增 `历史决定` tab（位于 `偏好与想法` 与 `仅本机保留` 之间）；顶部搜索 + 状态分段筛选 + 项目/时间/标签/可逆性下拉筛选；紧凑发丝线列表按 `decidedOn` 倒序展示事项、最终决定摘要、项目/范围、日期与状态徽标，底部说明不进入 `search_decision_context` 与复盘队列；附空态与读取异常态。
2. **历史决定详情弹窗**：沿用现有决策详情的左右双栏宽弹窗；左栏展示最终决定卡、备选方案、当时背景、相关链接与关联笔记、补充备注、单向「转为正式决策」入口；右栏展示追踪元信息、纵向演化链（前任/当前/后任决定可跳转）与状态切换；底栏左侧「撤回记录」。
3. **主动记录 › 历史决定**：在 `ActiveRecordDialog` 顶部类型切换中新增 `历史决定`；上半区只放决定事项、决定日期、最终决定、项目、来源、标签；下半区为可折叠「更多追踪信息」涵盖全部选填追踪字段，无理由/预期/复盘日期。
4. **实时采集与待补理由分流入口**：在实时采集 `RationaleStep` 与首页「待补理由」单条弹窗底栏中，与「记为偏好」平级新增「记为历史决定」，预填事项、所选答案、备选方案与上下文并打开确认弹窗，保存后原捕获不再保留。

## 6. MCP 工具设计（遵循 `docs/decisions/naming.md`）

不混入 `search_decision_context` 与 `consult_decision_principles`，新增 4 个独立工具并同步更新 `skills/paraself-memory/`：

- `record_historical_decision`：仅在用户明确要求记录时调用；支持第 3 节全部可写字段；基于同项目 + 事项 + 决定 + 日期的语义键去重，重复提交返回已存记录（`duplicate`）。
- `list_historical_decisions`：按 `query`、`project`、`status`（默认不含 `withdrawn`，可传 `includeWithdrawn: true`）、`tag`、`reversibility`、`fromDate`、`toDate` 分页列出，按 `decidedOn` 倒序。
- `get_historical_decision`：按 `id` 读取单条历史决定的完整内容、演化链上下游摘要与状态。
- `update_historical_decision`：修改字段、切换状态（`active` / `superseded` / `ended` / `withdrawn`）或更新替代关系，必须携带 `expectedRevision`（及变更状态时的 `expectedStatus`）防并发覆盖；按规范不提供物理删除，撤回使用 `status: "withdrawn"` 并保留历史。

## 7. 设计稿交付记录

状态：设计稿已画出并经用户确认（2026-11-21）；7.5 的七处取舍按画的做。

### 7.1 版本

- 统一设计稿：[Paraself 设计](https://claude.ai/artifact/CsaWzJMXPFhNHPNEGJuw23)，新增页面「历史决定」，页面 ID `historical-decisions`（[直达](https://claude.ai/artifact/CsaWzJMXPFhNHPNEGJuw23#page-historical-decisions)）。
- 更新前版本 ID `1795202739-31c8`；更新后为第 57 版，版本 ID `1795203875-9c10`。
- 本次只追加：1 个页面、4 张画板、5 条便签；未改动任何已有页面、画板、便签或排列，画布打开时的默认页仍是「待办」。
- 2026-11-21 补画变更历史（IMP-208，用户要求补上这块界面、其余自行决定）：在第 59 版（`1795227234-0c67`）上追加 1 张画板、1 条便签，发布为第 60 版，版本 ID `1795233004-7a51`。

### 7.2 画板

| 文件 | 标题 | 位置（x, y） | 尺寸 |
| --- | --- | --- | --- |
| [`HDList.dc.html`](https://claude.ai/artifact/CsaWzJMXPFhNHPNEGJuw23#artboard-HDList) | 1 · 知识 › 历史决定列表（下方：空态、部分笔记不可读、索引异常） | 0, 0 | 1160×1050 |
| [`HDDetail.dc.html`](https://claude.ai/artifact/CsaWzJMXPFhNHPNEGJuw23#artboard-HDDetail) | 2 · 历史决定详情弹窗（下方：已替代、已撤回、已转为正式决策） | 1240, 0 | 1160×1216 |
| [`HDRecord.dc.html`](https://claude.ai/artifact/CsaWzJMXPFhNHPNEGJuw23#artboard-HDRecord) | 3 · 主动记录 › 历史决定（下方：其余字段、折叠区默认收起） | 0, 1336 | 1160×1164 |
| [`HDTriage.dc.html`](https://claude.ai/artifact/CsaWzJMXPFhNHPNEGJuw23#artboard-HDTriage) | 4 · 实时采集与待补理由的「记为历史决定」入口（下方：待补理由弹窗底栏、点击之后） | 1240, 1336 | 1160×1100 |
| [`HDHistory.dc.html`](https://claude.ai/artifact/CsaWzJMXPFhNHPNEGJuw23#artboard-HDHistory) | 5 · 详情里的变更历史（下方：收起、状态变更、撤回日期、没有记录）（第 60 版） | 0, 2580 | 1160×1180 |

每张画板上方 `1160×760` 是正常界面，虚线以下是状态变体或续页，不与上面同时出现。

便签（都在新页面上）：`hd-title`（页面标题）、`hd-rules`（定位与边界）、`hd-flow`（入口与流程）、`hd-open`（待确认的取舍，见 7.5）、`hd-data`（示例数据与取值来源说明）、`hd-history`（变更历史的取舍，第 60 版）。

### 7.3 画前参考与取值

- 现有界面参考图 5 张，命令与交接文档 3.2 一致（`light 1160x760 purple`）：`decisions`、`decisions decision-detail`、`decisions schedule-record`、`rationale`、`dashboard pending-dialog`。截图存在会话临时目录，未入库。
- 颜色、字号、圆角、间距取自 `apps/desktop/src/renderer/styles.css`（浅色）与 `accent.ts` 的紫色预设（`--accent: #8b2fc9`、`--accent-ink: #61218d`、`--accent-surface: #f3eafa`、`--accent-border: #dfc5f0`），并对照上面的预览读出计算样式：窗口 `1160×760`、侧栏 56、分栏高 34、列表行 64、详情弹窗 `960×712`、主动记录弹窗 `760×704`。
- 图标沿用 renderer 现有的 20 格线稿；「历史决定」的时钟图标与在 Obsidian 打开、链接、笔记、撤回几枚是按同样线稿新画的，实现时需要补进图标集。

### 7.4 回读核对（版本 `1795203875-9c10`）

- 文件数 61 → 65，只多出 4 张新画板。
- 索引 `project/canvas.json`：顶层键、`title`、`launch`、`attachments`、`createdOnFiles`、`designSystems` 不变；原 5 个页面、27 张画板的配置、30 条便签逐项相同且顺序不变；新增项全部排在末尾，新画板互不重叠。
- 原 27 张画板文件的字节数与更新前一致，抽查 4 张（`OrgStatus`、`TSDraft`、`TSReview`、`DecisionEdit`）SHA-256 相同；回读的 4 张新画板与本地文件一致。
- **未核对**：没有在画布里逐张目检实际渲染（内置浏览器未登录 claude.ai）。发布前只在本地按普通 HTML 渲染检查过排版与溢出，需要用户打开画布确认。
- 第 60 版回读（`1795233004-7a51`）：`canvas.json` 与新画板 `HDHistory.dc.html` 和发布的文件逐字节相同；原有 31 张画板、35 条便签的配置逐项不变，`order`、`noteOrder` 只在末尾各多一项；抽查 `HDDetail`、`HDList` 两张与第 57 版一致。画布里的实际渲染仍未目检（内置浏览器仍未登录 claude.ai），只在本地渲染检查过。

### 7.5 待用户确认的取舍

交接文档没有写明、画的时候先定下的几处：

1. 列表「全部」包含已撤回（标题淡显）；`list_historical_decisions` 默认不含已撤回。
2. 日期统一写成 `2026-11-12`（带年份、等宽数字），没有沿用决策列表的「7月30日 16:30」。
3. 「记为历史决定」没有配快捷键。
4. 对已替代的记录点「恢复有效」，会同时解除它和后任决定的替代关系，先确认再执行。
5. 详情里的「转为正式决策」和空态里的「记一条历史决定」是次级按钮；主题色只留给页头「主动记录」和各处的保存、记录到知识库。
6. 列表行没有删除按钮，也没有「复制为 Markdown」。
7. 撤回后详情内容只读，要改先恢复有效。

## 8. 实现记录（IMP-207，2026-11-21）

### 8.1 落在哪里

- 协议 `packages/protocol/src/historical-decision.ts`，规则 `packages/core/src/historical-decision.ts`（建档、去重键、修订、替代成环检查、记录与修改的计划函数；App 的服务和 renderer 的预览用同一份）。
- 存储 `packages/storage/src/historical-decision.ts`（笔记读写）与 `historical-decision-index.ts`（索引与变更历史）。笔记在 `Decision Journal/history/<年>/<决定日期>-<事项>-<id 的 8 位哈希>.md`，属性区 `type: historical-decision`，正文五段各有一对标记；改写只动标记内的内容，读者在 Obsidian 里另加的段落保留。
- 索引是独立文件 `historical-decisions.sqlite`（userData 下），不放进 `index.sqlite`：后者重建时整份替换，变更历史会一起丢。三张表：`historical_decisions`（可随时从 Vault 重建）、`historical_decision_events`（变更历史，不可重建）、`historical_decision_meta`。
- 主进程 `apps/desktop/src/main/historical-decision-service.ts`：每次读先扫 Vault 再同步索引；索引打不开时列表返回 `index.state: "unavailable"` 和空列表，不拿空列表冒充没有记录；重建时把坏文件改名为 `.corrupt-<时间>` 留着。
- 界面 `HistoricalDecisionView`（列表）、`HistoricalDecisionDetail`（详情）、`HistoricalDecisionForm`（字段，主动记录和详情里的原地编辑共用），分流入口在 `RationaleStep` 和 `DashboardPendingRationales`。
- MCP `apps/bridge/src/mcp-historical-decision.ts`，经 App 的四条本机路由（`/v1/historical-decisions`、`/query`、`/get`、`/update`）。

### 8.2 与设计稿不同的地方

- 详情右栏「追踪信息」多一行「项目」：项目也在这一段里改。
- 相关链接、关联笔记在表单里是多行框（每行一条），画板上是单行框；一条记录最多 8 条，单行放不下。
- 链接芯片在名称后带上域名：名称是记录的人写的，域名说明它实际去哪。
- 「部分笔记不可读」的提示条没有「重新读取」按钮：笔记目录有监听，修好后列表自己更新。
- 索引异常只做了「完全读不了」这一种：索引每次读取前都与 Vault 同步，画板上「索引条数和 Vault 对不上」的状态不会出现。

### 8.3 MCP 工具与唯一的例外（IMP-208 定）

- 「在 Obsidian 打开」「打开链接」「打开关联笔记」有工具：`open_historical_decision`。先例是 `open_decision_source`（agent 在用户要求时打开来源笔记），这里照做；只能打开这条记录的笔记或它自己列出的链接、关联笔记，页面上的三个「打开」也改走同一个主进程函数，同一套校验。
- 「从 Vault 重建索引」仍不提供工具，这是唯一的例外。理由：它维护的是 App 自己的缓存文件，不是记录本身，App 里另外两处索引重建（「重建索引」「重建 Obsidian 检索」）也都只在界面上；需要重建的情况很少（索引文件损坏或被锁），而且遇到时 `list_historical_decisions` 会明确报错并请用户在 App 里重建，不会被当作“没有记录”。哪天其它索引重建有了工具，这一个跟着补。

### 8.4 命名：检索结果里的旧类型已改名（IMP-208）

`search_decision_context` 的结果原有 `kind: "historical_decision"`，指 `Decision Journal/summarize/` 下早期会话摘要里的决策（README 里叫「历史沉淀」），和这里的「历史决定」同名不同物：agent 看到它，容易拿它的 `DEC-…` 编号去调 `get_historical_decision`。IMP-208 把它改名为 `summarized_decision`，标签由「历史决策」改为「历史沉淀」（检索结果和交接材料里）。这个值只在扫描笔记时算出，不落盘，没有要迁移的数据；工具描述和技能里原先提醒“这是两回事”的话随之删去。

IMP-209 把全部带「历史」的命名梳理了一遍，定下一个名字一个意思：

| 说法 | 只指 | 标识 |
| --- | --- | --- |
| 历史决定 / historical decision | 这份留档台账 | `*_historical_decision`、`Decision Journal/history/`、`historical-*` 样式 |
| 历史沉淀 / summarized decision | `summarize/` 下早期会话摘要里的决策 | `summarized_decision` |
| 过往决策 / past decisions | 泛指以往的决策（检索能找到的决策记录与历史沉淀） | 无标识，只是说法 |
| 超过 30 天 | 首页待补理由里搁置超过 30 天的一条（原来的标签是「历史」） | `isStale`、`dashboard-stale-badge` |

改动：给 agent 看的工具标题和说明里泛指的 "historical decision(s)" 改为 "past decision(s)"（`search_decision_context`、`record_decision_relation`、两个反馈工具、服务说明、技能）；界面、README、交接材料、原则检索的文字结果和示例提示词里的「历史决策」改为「过往决策」（交接材料那句改为「决策记录」）；首页待补理由的「历史」标签改为「超过 30 天」，因为同一个弹窗里就有「记为历史决定」；说早期摘要笔记的代码注释改称 summarized。`CONTEXT.md` 在「决策记录」下注明避免说「历史决策」。

没改的：评审和问答两个模型自己的提示词（`pr-review-service`、`decision-assistant-service`）。它们带版本号、进评测，模型也从不接触历史决定，只为措辞改动会让提示词版本和评测对比断开，下次因别的原因改这些提示词时一并换掉。`scripts/lab/` 里钉住旧版本的守卫和实跑提示词同理，下次用时按惯例重抄；只有守卫里原则检索“无匹配”那一句当场重抄了，因为它的单元测试拿守卫和现在的 bridge 逐字对照。测试夹具里作为示例文字出现的「历史决策」（如「找历史决策降到 10 秒」）是数据，不是命名，也没改。`scripts/lab/mcp-guard.mjs` 钉在旧版本的措辞上，下次用它对新版 App 实跑时要按惯例重抄。

### 8.5 变更历史（IMP-208）

- 位置：详情左栏最底部，沿用决策详情「适用范围与关联」的折叠组，默认收起，右侧写条数；展开后按天分组，每条是时间、谁（「我」或 Agent 名）、做了什么，改了文字的字段在下面列出改前（红色划线）和改后（绿色），沿用决策「修订记录」的写法。改前为空写「（空）」，不划线。
- 记什么：每次经 Paraself 的修改（页面或 Agent）。事件里新存了各字段的改前改后（每段最多 1000 字，最多 20 个字段）；替代关系只写一句说明，不列编号。改状态写成「状态：旧 → 新」，状态说明列在下面；转为正式决策写在最前。旧版本记下的事件没有改前改后，照常显示。
- 不记什么：在 Obsidian 里直接改的（索引只同步内容，不知道是谁、改了什么），底部写明。
- 只读：不提供「恢复为这一版之前」。历史决定是留档，要回到以前的说法直接修改，或记一条新的替代它；改前的文字都在历史里，复制即可。
- 撤回提示条带上撤回日期，取自最近一次「→ 已撤回」的状态变更；在 Obsidian 里直接改成撤回的，没有这条记录，只写「这条记录已撤回」。
- `get_historical_decision` 的文字结果同样列出改前改后（每段截到 200 字，结构化结果里是全文），并说明只含经 Paraself 的修改。

