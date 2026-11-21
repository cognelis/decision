# 历史决定（Historical Decisions）任务交接（Handoff）

日期：2026-11-21
关联方案：`docs/historical-decisions-design.md`

---

## 1. 背景与已拍板结论（无需再次向用户确认）

用户希望补齐「**单纯记录历史决定 / 选择，方便以后追踪**」的能力——只记录事实与追踪上下文，不强求写理由、不进沉淀和复盘流。以下核心方向均已由用户明确确认：

1. **命名与定位**：**历史决定（`historical_decision`）**，面向人（及明确要求追溯时的 Agent）的决定台账。
2. **存储方式**：**Obsidian + SQLite**。
   - Obsidian 为事实源：独立目录 `Decision Journal/history/YYYY/<decidedOn>-<slug>-<shortId>.md`，单条一笔记，结构化属性写 YAML Frontmatter，正文仅管受控标记区间，用户手写段落原样保留。
   - SQLite 为独立本地索引 + 本机变更历史（沿用 `todo-history.ts` 模式），**不写入**现有 `decisions` 表，也**不写入**语义向量索引；索引可随时从 Vault 全量重建。
3. **与「仅本机保留」的关系**：**先独立分开**，不改动「仅本机保留」原有定位，后续视使用情况再考虑是否合并。
4. **严格隔离边界**（不进入以下链路）：
   - 不进入 `search_decision_context`（关键词与语义检索均不召回）与 `consult_decision_principles`；
   - 不进入首页「待补理由」与 14 天自动复盘提醒；
   - 不进入「整理与记忆（Organization）」、方法论提炼与决策分析的理由完整率统计。
5. **字段已定稿**（详见 `docs/historical-decisions-design.md` 第 3 节）：
   - **核心事实（仅前两项必填）**：`title`（决定事项）、`decision`（最终决定）、`decidedOn`（决定日期，默认今天）。
   - **追踪上下文（全选填）**：`options`（备选方案 ≤8）、`context`（当时背景/约束）、`project`（项目）、`scope`（影响范围）、`participants`（参与方 ≤12）、`sourceKind`（来源方式）、`reversibility`（可逆性：`easy` / `costly` / `irreversible`）、`references`（相关外部链接 ≤8）、`relatedNotes`（关联 Obsidian 笔记 `[[...]]` ≤8）、`tags`（标签 ≤12）、`notes`（补充备注，绝不标「缺理由」）。
   - **演化与状态**：`status`（`active` / `superseded` / `ended` / `withdrawn`）、`supersedesId`（替代了哪条历史决定，双向演化链、拒绝环路）、`statusNote`（状态变更说明）、`revisitCondition`（重看条件，纯静态备忘、不自动提醒）、`promotedDecisionId`（一键「转为正式决策」后的双向关联）。

---

## 2. 当前进度与未完成项

- **已完成**：
  - 需求拆解与现有代码基线核对（`packages/core/src/record.ts`、`packages/protocol/src/journal-entry.ts`、`apps/desktop/src/renderer/components/pages/decisions/ActiveRecordDialog.tsx`、`DashboardPendingRationales.tsx`、`RationaleStep.tsx`、`LocalDecisionList.tsx` 等）。
  - 完整设计与 MCP 方案已写入 `docs/historical-decisions-design.md`。
  - 设计稿已画出并经用户确认（2026-11-21），代码、测试、技能说明已完成（IMP-207）；交付记录见 `docs/iteration-roadmap.md` 的「历史决定」条目和 `docs/historical-decisions-design.md` 第 7、8 节。
- **以下第 3–5 节是当时的执行指南，留作记录，不再是待办。**

---

## 3. 下一步执行指南：绘制设计稿

### 3.1 目标设计稿

- 统一原稿：`https://claude.ai/artifact/CsaWzJMXPFhNHPNEGJuw23`
- 要求：**在原稿上新增一个独立页面（page）命名为「历史决定」**，不要新建替代文件，不要改动任何已有页面、画板、便签或排列。
- 更新完成后，回读原稿核对原有页面配置完整无损，并将新页面 ID、最终版本号与版本 ID 补写进 `docs/historical-decisions-design.md` 第 7 节。

### 3.2 画前参考截图（现界面基线）

开始绘制前，用预览脚本截取现有 5 个参考画面（使用预览数据，不碰真实 Vault）：

```bash
npm run preview:capture -- decisions /tmp/ref-decisions.png none light 1160x760 purple
npm run preview:capture -- decisions /tmp/ref-decision-detail.png decision-detail light 1160x760 purple
npm run preview:capture -- decisions /tmp/ref-active-record.png schedule-record light 1160x760 purple
npm run preview:capture -- rationale /tmp/ref-rationale.png none light 1160x760 purple
npm run preview:capture -- dashboard /tmp/ref-pending-dialog.png pending-dialog light 1160x760 purple
```

### 3.3 视觉规范（取自 `apps/desktop/src/renderer/styles.css` 与 `appearance.ts`）

- **画板尺寸**：主窗口 `1160×760`，浅色外观 + 紫色主题预设。
- **核心颜色**：
  - 窗口底 `--window: #eef0f3`；内容画布 `--canvas: #f6f7f9`；卡片/弹窗面 `--surface: #ffffff`；悬浮 `--surface-hover: #f1f3f6`；内嵌底 `--surface-inset: #f3f4f7`。
  - 发丝线 `--border: #e3e6eb`、`--border-muted: #edf0f3`、`--border-strong: #cfd4db`；投影归零（仅浮层/弹窗有阴影）。
  - 墨色文字 `--text: #16181d`、`--text-soft: #3c414b`、`--muted: #5f6673`、`--subtle: #656c79`。
  - 主题色（紫色预设）：`--accent: #8b2fc9`（浅底 `--accent-surface` 约 `#f3eaf9`，描边约 `#dfc5f0`），**严格仅用于唯一主操作按钮与激活态指示线**；分段选中、筛选选中用墨色/白底药丸，不用大面积紫色。
  - 语义色：有效 `--ok: #2b6e44` / `#e5f1e9`；已替代 `--warning: #8a5200` / `#f8eedd`；危险/撤回 `--danger: #b02f28` / `#f9e3e1`。
- **字号与尺度**：
  - `--t-micro: 9px`、`--t-small: 10px`、`--t-body: 11px`、`--t-base: 12px`、`--t-lead: 14px`、`--t-title: 17px`。
  - 圆角：`--r-xs: 2px`、`--r-sm: 4px`、`--r-md: 6px`、`--r-lg: 8px`；控件高 `--control-height: 28px`；标签栏高 `34px`。
  - 日期、编号与计数使用等宽数字（`tabular-nums`）。

### 3.4 需要绘制的 4 张画板（及下方状态变体）

1. **画板 1：知识 › 历史决定列表**
   - 沿用现有「知识」页壳；标签栏为 `决策` | `偏好与想法` | **`历史决定`**（紫色底线激活）| `仅本机保留` | `☆ 整理与记忆 1`；右上角主按钮 `主动记录`。
   - 列表卡片工具栏：搜索框（`按事项、决定、背景或备注搜索 /`）、状态分段筛选（`全部` | `有效` | `已替代` | `已结束` | `已撤回`）、下拉筛选（`项目`、`时间`、`标签`、`可逆性`）、结果计数。
   - 紧凑发丝线列表（按 `decidedOn` 倒序）：左列为决定事项（11px/600）+ 最终决定单行摘要 + 轻量微标（替代链提示 / 可逆性 / 标签）；中列为项目、影响范围与参与方/来源；右列为等宽决定日期 + 状态语义徽标 + `>`。
   - 列表底部轻提示条说明：存于 `Decision Journal/history/` 与本机索引，不进入 `search_decision_context` 与复盘队列。
   - 画板下方附两个紧凑状态变体：**空态**（引导「记一条历史决定」）与**部分笔记不可读/索引异常态**。

2. **画板 2：历史决定详情弹窗**
   - 沿用 `decision-detail` 的左右双栏宽弹窗（顶部含元信息、标题+行内编辑、在 Obsidian 打开、`< 1 / N >` 翻页）。
   - 左栏（白底，发丝线分隔）：`最终决定` 描边卡（带状态与可逆性徽标、编辑按钮）、`备选方案`、`当时背景`、`相关链接与关联笔记`（外部链接 + `[[Obsidian 笔记]]` 芯片）、`补充备注`、底部柔和卡片「转为正式决策」（若已转正展示跳转链接）。
   - 右栏（`#f6f7f9` 浅底）：`追踪信息`（决定日期、影响范围、参与方、来源方式、标签、重看条件并注明「仅作静态备忘，不自动提醒」）、`演化链`（前任决定 → 当前决定 → 后任决定，可点击跳转）、`状态管理`（`标记已替代` / `标记已结束` + 状态说明）。
   - 底栏：左侧红色文字按钮 `撤回记录`（不做物理删除，保留历史）；右侧 `关闭`。
   - 画板下方附变体：**已替代态 / 已撤回态（含恢复有效入口）** 与 **已转为正式决策态**。

3. **画板 3：主动记录弹窗 › 历史决定形态**
   - 沿用 `ActiveRecordDialog`；顶部分段切换器新增类型：`决策` | **`历史决定`** | `偏好` | `想法`。
   - 上半常用区（低摩擦录入）：`决定事项`（必填）+ `决定日期`（默认今天）、`最终决定`（必填 textarea）、`项目（可选）` + `来源` + `标签（可选）`。
   - 下半折叠区 `▾ 更多追踪信息（可选）`（画板展示展开状态）：`备选方案`、`当时背景`、`影响范围`、`参与方`、`可逆性`、`相关链接`、`关联笔记`、`替代哪条历史决定`、`重看条件`、`补充备注`。无理由、无预期结果、无复盘日期。
   - 底部说明文案与现有草稿栏一致，右侧 `保存记录 ⌘↩`。

4. **画板 4：实时采集与待补理由快捷分流入口**
   - 上半/主体对照 `RationaleStep`（实时采集 › 补充理由）：底栏展示新增分流按钮 `记录到知识库 ⌘↩` | **`记为历史决定`** | `记为偏好 ⌘P` | `跳过 ⌘L` | `仅本机保留` | `不保留 ⌘D`。
   - 下方并排展示首页「待补理由」单条弹窗底栏的变化：在 `记为偏好` 旁增加 **`记为历史决定`**，并标注点击后预填事项、所选答案、备选方案与上下文进入「主动记录 › 历史决定」确认弹窗，保存后原捕获不再保留。

---

## 4. 设计稿确认后的实现范围备忘（先不要动手写代码）

用户看过设计稿并确认后，再按以下清单实施：

1. **领域与协议**：`CONTEXT.md` 补术语；`packages/protocol` 新增历史决定请求/响应/查询/更新 schema；`packages/core` 新增领域模型、校验、去重语义键、替代链环路检测。
2. **存储（Obsidian + SQLite）**：`packages/storage` 新增 `Decision Journal/history/` 序列化/解析/原子重写器、独立 `historical_decisions` SQLite 索引表（含全量重建）与本机变更历史表；确认不触碰 `decisions` 表、`semantic-vector-index`、`search_decision_context`、`consult_decision_principles`、`organization`、`methodology`、`analytics`。
3. **桌面主进程与界面**：`apps/desktop` 新增 `HistoricalDecisionService`、IPC 接口、知识页「历史决定」tab、详情弹窗、主动记录「历史决定」形态、采集与待补理由「记为历史决定」分流、详情页「转为正式决策」。
4. **完备 MCP 工具**（遵循 `docs/decisions/naming.md`）：
   - `record_historical_decision`
   - `list_historical_decisions`
   - `get_historical_decision`
   - `update_historical_decision`（带 `expectedRevision` / `expectedStatus`，撤回用 `status: "withdrawn"`，不提供物理删除）
   - 同步更新 `skills/paraself-memory/` 用法说明（明确默认编码/评审不查历史决定，仅在用户明确要求记录或追溯时调用）与测试。
5. **验收与收尾**：全量 `npm run check`（去掉 `PARASELF_PROVIDER_CHILD` / `DECISION_PROVIDER_CHILD`）、更新 `docs/iteration-roadmap.md`、合并回 `main` 后按 `AGENTS.md` 构建验证并执行 `scripts/install-local-macos.py --apply` 安装到 `/Applications/Paraself.app`。

---

## 5. 新任务可直接粘贴的启动提示词

```text
请先阅读 docs/historical-decisions-handoff.md 和 docs/historical-decisions-design.md。
本轮任务只做第一步：先用 npm run preview:capture 截取现有界面参考图，然后在统一设计稿 https://claude.ai/artifact/CsaWzJMXPFhNHPNEGJuw23 中新增「历史决定」页面，按交接文档画出全部 4 张画板及状态变体（严格沿用 styles.css 变量和紫色主题预设，不改动原有页面与便签）。
画完后回读核对原稿完整性，更新 docs/historical-decisions-design.md 第 7 节的设计稿版本记录，然后停下来把结果发给我审阅，本轮不要修改任何产品代码。
```
