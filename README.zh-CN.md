# Paraself

[English](README.md) | 简体中文

Paraself 是一个本地优先的桌面应用，支持 macOS（Apple Silicon）和 Windows x64。它记下你做过的决定，再把这些记录交还给你和你的 AI agent。

Claude Code、Codex 或其他编码 agent 请你做选择、你回答之后，Paraself 会注意到，问你一句为什么，再把这条决策以 Markdown 存进你的 Obsidian 仓库。你也可以自己记下决策、偏好和想法。记录多了，就可以检索、提问、对照实际结果复盘，再提炼成原则；agent 给建议之前也能先查一查。

名字取自特德·姜笔下的 paraself：另一条时间分支上的你。Paraself 起步于配合编码 agent 使用的决策日志，目标是成为覆盖工作、学习和生活的个人分身。

界面目前只有中文。v1.2.0 及以前名为 Decision。

## 功能

- **采集**：装在编码 agent 里的被动 Hook 会捕捉 agent 向你提出的问题和你的回答，不论它用的是提问工具（`AskUserQuestion`、`request_user_input`）还是普通文字。明确的决策弹出简短的理由面板，拿不准的进入待处理队列，其余丢弃。Hook 不会阻塞 agent，也不改变它的行为。
- **主动记录**：随时记下一条决策、偏好或想法（⌘/Ctrl+N），包括会议这类线下做出的决定。
- **复盘**：做决定时写下预期结果，之后回填实际结果并复盘。值得复盘的决策会自动排在 14 天后，到期出现在首页的复盘收件箱。
- **知识**：检索你的决策、偏好、想法和 Obsidian 笔记；决策和笔记还能用本机语义向量按含义匹配。「问答」只依据这些内容回答，并注明出处。
- **方法论**：从复盘过的决策中提炼原则（人工整理或用模型提炼），跟踪原则采用后的效果，再整理成技能和流程，发布到 Codex 或 Claude Code。
- **给 agent 用**：通过 MCP，agent 可以在给出选项前核对你已采纳的原则，在写代码或评审时查找过往决策，并记下你明确要求记录的内容。
- **PR 评审**：浏览 GitHub、GitLab 和 Bitbucket Server / Data Center 上的 PR，运行只读的 AI 评审（同时核对过往决策和评审规则），经你确认后再发评论、批准或合并。PR 评论里做出的决定也可以记成决策。
- **待办**：让 agent 把调研结果存成一份待办清单，一项一个复选框；也可以先建日常、学习这类空清单，有新的待办再往里加。之后在「待办」页、在 Obsidian 里，或交还给 agent 逐项处理。agent 完成或放弃一项时要写明做了什么、怎么核对的，每次变化都留有记录。
- **历史决定**：在「知识 › 历史决定」里给已经拍板的选择留一份台账：决定了什么、什么时候定的，其余（备选方案、背景、链接、替代了哪一条）想填再填。不要求写理由，也不安排复盘；除非你把其中一条转为正式决策，它们不进入决策检索和复盘。
- **提示词**：在「提示词」页保存常用的提示词（比如让 `paraself-review` 检查当前分支），复制到 Codex 或 Claude Code 使用。首次打开会放入三条示例，可以随意编辑或删除。

## 采集是怎么工作的

1. agent 提问，你照常在它自己的界面里回答。
2. Hook 把问题和回答复制到本机的私有队列，随即以成功状态退出，agent 不用等 Paraself。
3. Paraself 用本地规则（启用后再加本机模型）给这次问答打分。模型不能单独弹出理由面板：规则和模型意见不一致时，这条进入待处理队列。
4. 在面板里处理之前，什么都不会写进仓库。处理完成的写成 Markdown，再据此更新检索索引。

## 安装

从 [GitHub Releases](https://github.com/cognelis/decision/releases) 下载最新版本：

| 平台 | 文件 |
| --- | --- |
| macOS（Apple Silicon） | `Paraself-darwin-arm64-<version>.zip`：解压后把 `Paraself.app` 放进 `/Applications` |
| Windows x64 | `Paraself-<version>-win-x64-Setup.exe` |

制品没有商业证书签名：Windows 安装器未签名，macOS App 为 ad-hoc 签名且未经公证，首次打开时 SmartScreen 或 Gatekeeper 会提示。请先核对 Release 里的 SHA-256，再按[发布说明](docs/release-notes.md)打开。没有自动更新。

## 开始使用

1. 打开 Paraself。它会使用你最近打开的 Obsidian 仓库，没有的话新建 `~/Documents/Paraself Vault`；可以在「通用」页更换。
2. 在「接入」页接入你用的 agent。「全部修复」会一次配好本机检测到的所有 agent。接入后重启这些 agent。
3. 在「模型」页确认由哪些模型做识别；需要的话在这里安装本机 Qwen 模型。
4. 要评审 PR，在「链接」页添加代码平台。

记下第一条决策之前，首页会显示一份上手清单。

## 支持的 agent

| Agent | 状态 |
| --- | --- |
| Claude Code、Codex、Grok | 已实测 |
| Antigravity、Qwen Code、Qoder CLI、Augment Auggie、Gemini CLI、Cursor CLI、GitHub Copilot CLI、CodeBuddy Code、Factory Droid | 按官方文档和源码实现，尚未实测（App 里标「未实测」） |

Paraself 给每个 agent 安装被动 Hook，并注册名为 `paraself` 的 MCP 服务；配置文件里的其他内容原样保留。列表里没有的工具，可以在「接入」页底部点「接入其他工具」：助手提出接入方式，你确认后 Paraself 临时装上探针 Hook，再根据一次真实问答推断出事件字段。

接入看起来有问题时，可以在终端里用 bridge 检查和修复。Windows 上换成 `%LOCALAPPDATA%\Paraself\paraself-bridge.cmd`。

```bash
"/Applications/Paraself.app/Contents/Resources/bridge/paraself-bridge" doctor
"/Applications/Paraself.app/Contents/Resources/bridge/paraself-bridge" install --dry-run
"/Applications/Paraself.app/Contents/Resources/bridge/paraself-bridge" install --apply
```

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `consult_decision_principles` | 给出选项前：返回最多 3 条与问题相关的已采纳原则，相关的偏好和想法单独列出。只读。 |
| `search_decision_context` | 写代码或评审时：按项目、仓库、模块和文件查找过往决策、已采纳原则和历史沉淀，已被替代的记录会标出。只读。 |
| `record_decision_journal_entry` | 记下用户明确说出的决策、偏好或想法。 |
| `record_decision_outcome` | 为已记录的决策回填实际结果和复盘。 |
| `record_decision_scope`、`record_decision_relation` | 记下决策的适用范围，以及决策之间的冲突或替代关系。 |
| `record_decision_context_feedback`、`list_decision_context_feedback`、`record_decision_consultation_feedback` | 记录和读取检索到的上下文、原则核对是否有帮助。 |
| `open_decision_source` | 在 Obsidian 中打开来源笔记。 |
| `prepare_decision_handoff` | 用选定的决策生成只读的交接内容。 |
| `record_todo_list` | 在用户要求时，把调研结果存成待办清单、建一份空清单（如日常、学习），或往已有清单里追加事项。 |
| `list_todo_lists` | 读取还有未完成事项的待办清单，以及每一项的状态、说明和最新的处理说明。只读。 |
| `update_todo_item` | 把一项标为处理中、已完成或已放弃，或补一句说明；完成和放弃必须写明做了什么、怎么核对，或者为什么不做。 |
| `record_historical_decision` | 在用户要求时，把一个已经作出的选择记进历史决定的台账。只有事项和决定必填；重复提交返回已有的那条。 |
| `list_historical_decisions`、`get_historical_decision` | 按关键词、项目、状态、标签、可逆性或日期列出历史决定，并读取其中一条的全部内容、它替代的和替代它的记录、变更历史。只读；与 `search_decision_context` 分开，后者不会返回它们。 |
| `update_historical_decision` | 在用户要求时，基于刚读到的修订修改一条历史决定的字段或状态。撤回代替删除；`promote` 把它转为正式决策，只能转一次。 |
| `open_historical_decision` | 在用户要求时，在 Obsidian 中打开一条历史决定的笔记，或打开它自己列出的链接、关联笔记。 |
| `search_obsidian_notes`、`get_obsidian_note` | 检索 App 已建立索引的普通 Obsidian 笔记，并分页读取其中一篇，返回路径和行号。只读；普通笔记没有项目范围。 |
| `record_review_benchmark_cases` | 在用户要求整理评审评测集时，把历史 PR 录成候选样本：缺陷集（评审该找出的问题，附位置和修复提交）或干净集（没有问题）。App 会在本地仓库里核对每个提交和行号。 |
| `list_review_benchmark_cases`、`get_review_benchmark_case` | 列出一个仓库的样本和各集合的数量，读取一个样本的标注和变更记录。留出集样本不返回标注。只读。 |
| `update_review_benchmark_case` | 修改样本的标注或引用、加备注、撤回；用户说核对过之后确认入集。 |
| `run_review_benchmark` | 按你的要求在 App 里把一个仓库已确认的样本按现在的评审方式重评一遍，按集合计分；改评审提示、模型或规则前后各跑一次。每个样本都会花模型额度。 |
| `list_review_benchmark_runs`、`get_review_benchmark_run` | 评测记录，以及一次评测的总数和与上一次的对比（先看召回，再看有害意见）；留出集只给总数。意见是否有害、要不要采用，在 App 里由你决定。只读。 |
| `list_prs` | 列出代码平台连接上的 PR（待我评审、我创建的、已合并），附上 Paraself 里最近一次评审的风险等级、第几轮和问题数，以及平台上的构建状态、人工批准数和未完成的阻塞项。只读。 |
| `list_pr_reviews`、`get_pr_review` | 列出 Paraself 保存的 PR 评审，读取其中一次：风险等级，每个问题的依据（仓库规则，还是只有你的个人决策、只能作建议），以及发到 PR 的问题作者怎么回应。只读。 |
| `run_pr_review` | 按你的要求在 App 里开始一次评审，和评审页一样：读最新的 PR，高风险的默认深度评审，之后几轮只看新提交改动的部分。立即返回记录，用 `get_pr_review` 看结果；不向 PR 发任何东西。 |
| `get_pr_review_settings`、`update_pr_review_settings` | 读取每个链接的自动预评审设置（只读）；按你的要求打开（选模型、每天最多几次）或关闭。打开后，App 会在待你评审的 PR 新出现或有新提交时自动评审，一次一个，同一个 PR 过了第三轮不再评审，结果只留在本机。默认关闭：它会花模型额度。 |
| `update_pr_review_finding` | 按你的要求把一个问题标为不采纳并写明原因，或撤回不采纳；以后评审同一仓库时会告诉模型。只改 Paraself 里的记录。 |
| `record_pr_comments` | 按你的要求把评审里选定的问题发到 PR 的对应行；P1 默认设为阻塞（Bitbucket 上是任务），只有个人依据的问题不能设为阻塞，除非是依据你标记为 `enforcement: blocking` 的本机评审规则的 P1，这时评论会完整引用规则原文；已发过的不会重发。批准和合并没有工具。 |
| `list_pr_comments`、`update_pr_comment` | 你自己的 PR 收到的意见（人和 Paraself 预评审的），以及每条的去向；你说了怎么处理、为什么之后，用标准回复回应一条：误报、有意为之、不处理，或转后续（先在「PR 后续」清单里建待办）。 |
| `record_local_review_job` | 按你的要求把意见交给本地审阅修改：本地工程改动上的批注，或你自己 PR 上的意见。PR 的修复要你在 App 里确认推送，才作为新提交推到原分支，而且只在分支头没变时推。 |
| `list_local_review_jobs`、`get_local_review_job` | 本地审阅的任务，以及单个任务的细节：每条意见的评估和修改结果、提交、高风险文件、验证记录。只读。 |
| `update_local_review_job` | 按你的要求取消进行中的任务，或重试失败的组和评估。推送、高风险改动的授权只在 App 里。 |
| `get_review_quality` | 一个连接近 30 天的评审质量，和之前 30 天对比：从平台读每个已合并 PR 的人工批准数、人工评论数、等人批准的中位时间和回滚数；已发布意见按依据分的结果；常被作者说错的规则。只读。 |
| `update_review_rule` | 按你的要求停用或重新启用一条自己的本机评审规则。 |
| `list_review_escapes` | 评审漏掉的问题：合并后被回滚、或被后来的 PR 修复的 PR，以及每条的复盘（问题、本该哪一层拦住、为什么没拦住、改在哪里）。只读。 |
| `list_rule_promotion_candidates` | 评审一再用到、只在你 Paraself 里的规则（决策、本机评审规则），以及漏网复盘说要改规则的，附上依据、例子和写进仓库 REVIEW.md 的草稿。提议时交给本地审阅改文件，你在 App 里确认后才开 PR。只读。 |
| `record_review_escape`、`update_review_escape` | 按你的要求记下你指出的漏网，写复盘的四行，写明理由标为不是漏网，或按问题所在位置做成评测集缺陷集的候选样本。 |
| `get_pr_description_draft`、`update_pr` | 读 PR 现在的描述，按团队模板起草缺的验证、风险、撤回三段，作者写的原样保留；你确认文字后写回，写回前核对描述没被别人改过。不包括批准和合并。 |

没有任何 MCP 工具能删除决策、待办清单、历史决定或评测集样本。

接入 Codex 或 Claude Code 时会一并装上两个 Skill，Paraself 更新后也会跟着更新：[`paraself-memory`](skills/paraself-memory/SKILL.md) 告诉 agent 什么时候、怎样用这些工具；[`paraself-review`](skills/paraself-review/SKILL.md) 在代码、PR 或方案评审时对照你的决策和笔记核对。Codex 装在 `~/.agents/skills`，Claude Code 装在 `~/.claude/skills`。你改过的 Skill 文件夹、别的工具放的同名 Skill 不会被动，接入结果里会说明。Paraself 以前发布的 `decision-context` 原样副本会被移除，改过的保留。断开接入不删除这些 Skill。

## 模型

Paraself 按「模型」页设定的顺序依次尝试已启用的后端。默认：

1. Apple Foundation Models：macOS 自带，完全在设备上运行。
2. 本机 Qwen3.5：4B（推荐，约 3 GB）或 2B（约 1.3 GB），在「模型」页安装。
3. 规则：没有模型可用时使用。

采集分类每一轮对话都会运行，所以默认只用规则和本机 Qwen 4B，从不调用远端服务。

还可以添加 OpenAI（Responses API）、Anthropic（Messages API）、任意 OpenAI 兼容 API（带 DeepSeek 预设），或者直接用本机已登录的 Codex CLI 和 Claude Code CLI。这些默认关闭；启用后，当前任务裁剪后的内容会发给对应的服务商。API Key 默认用操作系统的加密存储保存，开启「本地密钥模式」后改存本机的私有文件。每次模型调用都在本机留有记录，写明 token 数，填了单价的还会折算金额。

语义检索使用 Qwen3-Embedding-0.6B 模型（约 640 MB），目前只能在源码目录里用 `npm run prepare:model` 安装；没有它时只按关键词检索。

## 数据与隐私

Obsidian 仓库里的 Markdown 是唯一事实来源。Paraself 写在仓库的 `Decision Journal/` 下：

```text
Decision Journal/
  decisions/YYYY/MM/   决策
  preferences/         偏好
  ideas/YYYY/MM/       想法
  todos/YYYY/MM/       待办清单
  history/YYYY/        历史决定
  principles/          候选和已采纳的原则
  skills/ workflows/   由原则整理出的技能和流程
  decision-scopes/ decision-relations/ decision-feedback/ principle-relations/
  summarize/           历史沉淀，只读取、不写入
```

App 自己的数据在 macOS 的 `~/Library/Application Support/Paraself/`、Windows 的 `%APPDATA%\Paraself\`：

| 数据库 | 内容 |
| --- | --- |
| `index.sqlite` | 决策的检索索引，可以从 Markdown 重建 |
| `semantic-vectors.sqlite` | 决策、原则和历史沉淀的语义向量，可以重建 |
| `obsidian-search/vaults/<id>/index.sqlite` | 仓库里其他笔记的索引，可以重建 |
| `local-decisions.sqlite` | 选择「仅本机保留」的决策。这是它们唯一的一份，不能重建，请备份。 |

同一目录下还有等你处理的采集队列、待办清单的变更记录（`todo-history/`，只存在这台电脑上，不写进仓库）、整理与记忆的建议与处理记录（`organization/`，含不采纳的回执和整理进度，同样只在这台电脑上），模型调用记录（保留 7 天，最多 1,000 条），以及保存的提示词（`prompts.json`，只在这台电脑上）。历史决定的索引和每条的变更历史在 `historical-decisions.sqlite` 里：索引能从笔记重建，变更历史不能。备份时保留仓库、`local-decisions.sqlite`、`historical-decisions.sqlite`、`todo-history/`、`organization/` 和 `prompts.json` 就够了，索引可以在设置页重建。删除 App 不会删除你的笔记。

- 除非你启用远端 API 或 CLI 后端，所有内容都只留在本机。
- 决策只保存上下文摘录，不保存完整对话记录；Hook 只读取本机对话记录末尾的有限部分。
- App 的本地服务只监听 `127.0.0.1`，端口随机，每次启动生成新的令牌。

## 从 Decision 升级

首次启动时，Paraself 会把旧的 `Decision` 数据目录改名为 `Paraself`，继续使用原来的仓库和其中的 `Decision Journal` 目录，也仍然读取 `DECISION_*` 环境变量。Decision 接入过的 agent 会显示需要重新连接，点「全部修复」即可换成新的接入。之后删除旧的 Decision App。

## 从源码构建

需要 Node.js `>=22.19.0 <26`（推荐 22 LTS）和 npm；macOS 还需要带 macOS 26 SDK 的 Xcode Command Line Tools。不需要 API Key 或证书。

```bash
git clone https://github.com/cognelis/decision.git
cd decision
npm ci --ignore-scripts
npm run setup:electron
npm run check
npm run make
```

`npm run make` 按当前系统生成安装包：macOS 在 `out/make/zip/darwin/arm64/`，Windows 在 `out/make/squirrel.windows/x64/`。发布流程见 [docs/release.md](docs/release.md)。

| 命令 | 作用 |
| --- | --- |
| `npm run check` | 类型检查和完整测试 |
| `npm run quality` | CI 运行的内容：`check` 加语义识别门禁 |
| `npm run build` | 把 App 打包到 `out/`，不生成安装包 |
| `npm run smoke` | 用临时仓库启动打包好的 App，完整跑一次真实采集 |
| `npm run prepare:model` | 下载本机 Qwen 生成模型和嵌入模型 |
| `npm run replay:pr` | 用真实 PR 回放评审流程（[说明](docs/pr-review-replay.md)） |
| `python3 scripts/install-local-macos.py --apply` | 在 macOS 上把构建结果安装到 `/Applications`，失败时自动回滚 |

更多文档：

- [docs/semantic-recognition.md](docs/semantic-recognition.md)：识别和本机模型怎么工作、怎么评估
- [docs/decisions/](docs/decisions/)：实施决策和命名约定
- [docs/iteration-roadmap.md](docs/iteration-roadmap.md)：每轮迭代交付了什么、为什么

## 许可证

[MIT](LICENSE)，版权归 Cognelis contributors 所有。
