# Paraself 命名约定

2026-10-28，用户决定把产品从 Decision 全面改名为 Paraself，并选择“兼容迁移”：对外与内部的品牌标识统一换成 Paraself，旧名只保留为一次性读取、迁移和清理入口。“决策”仍是产品的核心领域概念，领域用词不随品牌改名。

| 对象 | 当前名称 | 改名前（只读取、迁移、清理） |
| --- | --- | --- |
| 产品 | Paraself | Decision |
| 组织 | Cognelis | — |
| npm 根包 | @cognelis/paraself | @cognelis/decision |
| workspace 包 | @cognelis/decision-*（内部包名，暂未改） | — |
| macOS Bundle ID | com.cognelis.paraself | com.cognelis.decision |
| 发布制品 | `Paraself-<version>-win-x64-Setup.exe`、`Paraself-darwin-arm64-<version>.zip` | `Decision-…` |
| MCP 服务注册 | paraself（Claude Code 中工具前缀为 `mcp__paraself__`） | decision：确认运行的是本应用的 bridge 才在接入或断开时移除 |
| CLI 入口 | paraself-bridge；Windows 为 paraself-bridge.cmd，安装根目录启动器 `%LOCALAPPDATA%\Paraself\paraself-bridge.cmd` | decision-bridge(.cmd)：仍认作本应用的 bridge |
| 环境变量 | PARASELF_ 前缀 | DECISION_ 前缀：新名缺省时读取，来源记为 legacy |
| Hook 标记 | PARASELF_HOOK=1；Windows 为 PARASELF_HOOK=2（经 cmd 运行，作为最后一个参数） | DECISION_HOOK=：认作本应用，状态显示需重新连接，接入时替换 |
| 客户端专属名称 | Antigravity 钩子 `paraself`；Grok、Copilot 的 `paraself.json` | `decision` 钩子改名过来；`decision.json` 去掉本应用的钩子，空了就删除 |
| 默认应用数据目录 | macOS / Windows 使用 Paraself，Linux 使用 paraself | Decision / decision：首次使用前整目录改名 |
| 全新安装默认 Vault | ~/Documents/Paraself Vault | ~/Documents/Decision Vault：设置丢失且只有它时继续使用 |
| 领域名称（不改） | Decision Journal 目录、`<!-- decision:` 结构标记、DEC 编号、`local-decisions.sqlite` 等文件名 | — |
| MCP 工具名 | 按下文“MCP 工具命名”；工具名里的领域词 decision 不随品牌改 | 2026-11-18 统一时改掉的三个旧名不保留，见下文对照表 |
| 界面术语 | 决策面板、理由面板、紧凑面板 | — |

应用数据目录的迁移由 App 与 bridge 共用（`config/user-data-directory.mjs`），在任何一方读写目录之前执行：新目录不存在而同一父目录下有旧目录时整体改名；两个都在时使用新目录、旧目录原样保留；从不合并或删除。另一个进程先完成改名时直接使用新目录；其它原因失败时这一次继续使用旧目录，App 提示原因并在下次启动重试，Hook 照常静默退出。用环境变量明确指定目录时不迁移。

新安装和接入只生成上表“当前名称”一栏的名称。已有决策不得因命名修改而丢失或改变选择、理由和结果；Obsidian 笔记格式与 `Decision Journal` 目录不变。

## MCP 工具命名（2026-11-18）

用户 2026-11-18 要求统一命名规范，并要求以后提供功能时同步补齐完备的 MCP 工具。本节适用于 `paraself` MCP 服务的全部工具。

格式是 `动词_对象`：全小写，单词之间用下划线。服务名已经是前缀（Claude Code 里是 `mcp__paraself__`），工具名里不再写 paraself。

### 动词

只用下表的动词：

| 动词 | 用于 | 读写 |
| --- | --- | --- |
| search | 按查询词检索，结果按相关度排序，分页 | 只读 |
| list | 按条件列出一类对象，按时间或编号排序，分页；可以带简单过滤 | 只读 |
| get | 按编号读一个对象，或读一份汇总 | 只读 |
| record | 新建记录，可以批量；也用于给已有对象追加一条带版本的事实（范围、关系、结果、反馈）。重复提交同样的内容，返回已存的那条 | 写 |
| update | 修改已有对象：改字段、追加备注、改状态。确认、撤回、重新打开都用 update 的参数表达，不另起工具 | 写 |
| run | 启动会消耗模型调用的任务（评审、评测），返回任务编号；进度和结果用 get 读 | 写 |

上面都不贴切时才用领域动作，而且要先在这里登记。已登记的有三个：

- consult：做选择前查已采纳的原则；
- prepare：生成交接材料；
- open：在 App 里打开。

### 对象

- 用领域名词，与 `CONTEXT.md` 的术语一致；新功能的领域名词随功能补进 `CONTEXT.md`。由多个词组成时按“领域_实体”排列，例如 `decision_journal_entry`、`todo_item`、`review_benchmark_case`。
- 不用自造缩写（eval、ctx、cfg）。通用缩写可以用：PR 一律写作 `pr`，复数写 `prs`，不混用 `pull_request`。
- 单复数：list、search 的对象用复数；get、update 用单数；record 一次只建一个时用单数，可以批量时用复数。不可数的名词照原样，例如 context、feedback。

### 完备

- 一项功能的 MCP 工具至少要覆盖读（list 或 search，加 get）和写（record、update）。用户在界面上能做的事，agent 经 MCP 也能做，受同样的确认和权限约束。
- 例外要在功能方案里写明理由。例如批准、合并 PR 不提供工具，因为 AI 的批准不算人。
- 写工具的描述里写明只在用户要求时使用；重复提交不产生副本；改状态时带 `expectedStatus`，防止覆盖别人刚做的修改。
- 不提供删除，用撤回代替，保留历史。
- 读工具不返回不该给 agent 看的内容，并在描述里写明，例如评测留出集的答案。
- 新增或改动工具时，同一版本里更新 `skills/` 的用法说明和测试。

### 现有工具对照

| 现名 | 是否符合 | 新名 |
| --- | --- | --- |
| `search_decision_context`、`search_obsidian_notes` | 符合 | — |
| `consult_decision_principles`、`prepare_decision_handoff`、`open_decision_source` | 符合，领域动作 | — |
| `record_decision_journal_entry`、`update_decision_journal_entry` | 符合 | — |
| `record_decision_scope`、`record_decision_relation`、`record_decision_outcome` | 符合，追加带版本的事实 | — |
| `record_decision_context_feedback`、`record_decision_consultation_feedback` | 符合 | — |
| `record_todo_list`、`update_todo_item` | 符合 | — |
| `record_historical_decision`、`list_historical_decisions`、`get_historical_decision`、`update_historical_decision`、`open_historical_decision` | 符合（IMP-207 新增；open 是已登记的领域动作） | — |
| `get_decision_context_feedback` | 不符合：读的是一页反馈 | `list_decision_context_feedback` |
| `get_todo_lists` | 不符合：读的是一页清单 | `list_todo_lists` |
| `read_obsidian_note` | 不符合：read 不在动词表里 | `get_obsidian_note` |

这三个工具一次改完，同一版本里更新技能（App 会把技能同步到 Codex、Claude Code）、测试和文档，发布说明列出新旧对照。旧名不保留为别名：MCP 客户端只调用列出来的工具，不列出就没人能调；同时列出又会让 agent 看到重复的工具。2026-11-18 核对过，本机的 Claude Code 和 Codex 配置里没有按这三个旧名放行的许可。已在 IMP-193 同一版本里改完。

## 此前的约定

2026-09-10，用户要求当时的产品全面使用 Decision 命名，取消早期品牌别名与顶部界面隐喻；早期笔记通过一次性迁移更新结构标记（`scripts/migrate-markdown-markers.mjs`），旧应用数据目录完整归档。那次改名的兼容入口在 1.x 中已移除，原始历史可从 Git 查阅。
