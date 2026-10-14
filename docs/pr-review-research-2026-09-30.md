# PR 评审流程：调研、评估与重构（2026-09-30）

问题：Decision 之前的代码评审是逐个文件评审的，code-meeseeks 也是这样吗？行业最佳做法也是这样吗？调研评估之后，结合 Claude Code 的评审逻辑，重构完整评审、PR 概览和改进建议。

## 结论

- **之前的 Decision 比“逐文件”还碎**：每个文件的 diff 再切成不超过 60 行、4000 字的页，每页单独跑一轮 agent。模型一次只看到一个文件的 60 行，前面几页只留下三段摘要。
- **code-meeseeks 不是逐文件**：它驱动 pr-agent。`/review` 和 `/describe` 都是整个 PR 放进一个 prompt、调用一次；`/improve` 按块调用，整个 PR 放得下时就是一块。它自己的 agent 层也按 PR 工作，不按文件。
- **行业主流也不是逐文件**：调研到的系统里，只有 2023 年的 CodeRabbit（和它开源的 ai-pr-reviewer）是一个文件调用一次，还要往每次调用里塞 PR 摘要来补跨文件信息。现在的共识是：
  - 以整个 PR 为单元，超预算时打包成多文件块，并写明漏审了哪些文件；
  - 按问题类别（而不是按文件）并行审查；
  - 上下文由模型按需检索；
  - 每条发现单独验证，再去重、分级，宁缺毋滥。
- **重构后**：
  - 完整评审按所选模型一次能读的长度，把相关文件打包成“评审分组”，大多数 PR 用远端模型一组读完；分几组时先写整个 PR 的梗概；汇总后按 Claude Code 的 0–100 置信度标准逐条核验，低于 80 分的移出问题列表。
  - PR 概览和改进建议照 pr-agent 的做法改成独立流程。
  - 所有 prompt 按模型预算装配，不再超出网关上限。

## 1. 之前的实现（按代码核实）

- **切批**：`splitReviewBatches` 逐个文件切，按行累计，超过 4000 字或满 60 行就切一批，批次边界可能把 hunk 从中间切开。一个 1500 行的文件要 25 批、至少 25 次模型调用。
- **每批的上下文**：只有这一页 diff，加上最近 3 批的摘要（2000 字）和其它文件的路径（最多约 800 字）。系统提示词还在描述翻页，但这一页的行已被标成“已读”，别的文件又不许读，`read_diff` 实际上用不了。
- **合并**：各批的问题只按整条 JSON 完全相同去重，没有独立核验。报告摘要是各批摘要拼接。
- **超时**：每批 10 分钟时限，但它中止的是整次评审的控制器，一批超时整个评审就停了。
- **PR 概览和改进建议**：只是在渲染层把命令展开成一段预设问题，再当普通追问发出。主进程把整个 diff 首尾拼接后截到 2 万字（排在后面的文件整个被截掉），一次调用、没有工具，输出一段自由 Markdown。
- **请求长度**：网关要求 system、user prompt 各不超过 2 万字符，但追问的 user prompt 最多可拼到“上下文 6 万 + diff 2 万 + 对话”，大 PR 上在调用模型之前就会被网关拒绝；复评的 diff 也能到 2 万。现有测试用的是假网关，没发现这个问题。
- **本机模型**：Qwen3.5-2B 的上下文只有 4096 token，结构化输出最多 1024 token。

## 2. code-meeseeks

本机仓库 `~/git/code-meeseeks`，已安装的 App 内置 pr-agent 0.39.0（仓库锁定 0.45.0）。它为每个工具起一个 pr-agent 子进程，diff 来自本地 git 镜像的 merge-base..HEAD。

| 命令 | 评审单位 | 每次运行的调用数 | 大 PR 的处理 | 验证与过滤 |
|---|---|---|---|---|
| `/review` | 整个 PR，一个 prompt | 1 | 放得下就整体发送（hunk 前补 5 行、后补 1 行，并回溯到所属函数头）；放不下时去掉扩展行和删除专属的 hunk，按语言分组、组内按大小装入一个包，其余文件只列名字，不做第二次调用 | 没有自评或打分，只在 prompt 里要求“不确定就不报”；code-meeseeks 另加分诊、复评（keep、replace、drop）和人工确认草稿 |
| `/describe` | 整个 PR，一个 prompt | 1 | 同上；模型漏掉的文件由程序补进逐文件说明表 | 无 |
| `/improve` | 文件块，放得下时整个 PR 是一块 | 每块 2 次（生成、自评），最多 3 块并行 | 顺序装块，超过 3 块的文件被静默丢弃；单个文件过大时截断 | 强制自评：每条建议 0–10 打分并定位行号，丢弃 0 分；按分数分“高 / 中 / 低” |

预算：pr-agent 默认 32k token，code-meeseeks 覆盖为 128k（CLI 模式固定 128k）。pr-agent 的评审 prompt 要求“只关注这次 PR 新增的代码、只报这次引入的问题”“宁可不报，也不要猜”。

## 3. 行业做法

- **PR-Agent / Qodo Merge**：token 预算内一次调用；超出时按语言占比与大小压缩，其余文件只列名字。`/describe` 在大 PR 上最多 3 块并行写逐文件摘要，最后一次调用汇总标题、类型和摘要。`/improve` 最多 3 块，每块 3 条建议，之后一次反思调用给全部建议打 0–10 分，文档、类型注解、未使用导入之类的建议记 0 分。Qodo 商业版改为正确性、规范、架构、风险几个专项 agent 并行，再由 judge 合并、去重、过滤低置信结果。
- **CodeRabbit**：2023 版逐文件审，每次带上 PR 摘要；2025 年以后改为 code graph、语义索引、40 多个 linter/SAST 工具加 learnings，由验证 agent 写 grep/ast-grep 脚本取证后再发评论。
- **GitHub Copilot**：2026 年 3 月起改为 agentic，按需读取相关文件；长 PR 先定审查计划；29% 的审查不发评论；同类问题合并成一条。
- **Cursor Bugbot**：对整个 diff 跑 8 次（文件顺序随机），相似问题归桶、多数表决，再由 validator 复核；后来改为 agentic。
- **Greptile**：带代码搜索工具的 agent 循环。他们实测发现让模型给自己的评论打严重度分“近乎随机”，改用团队对评论的反馈做过滤后，评论被处理的比例从 19% 升到 55% 以上。
- **其他**：Ellipsis 按问题类型并行生成，再去重、置信度过滤、凭证据查幻觉；Sourcery 每条评论单独交给一个模型校验，有用率从四成出头升到约六成；Uber uReview 由 grader 给置信分，按“助手 × 语言 × 类别”设阈值；Google AutoCommenter 只评改动过的行，每条最佳实践单独设阈值；OpenAI 给审查模型仓库访问和代码执行能力，精确率优先。

## 4. Claude Code 的评审逻辑

本机插件 `~/.claude/plugins/marketplaces/claude-plugins-official/plugins/code-review/commands/code-review.md`：

1. 先检查 PR 是否已关闭、是草稿、明显不需要评审，或已经评审过。
2. 找出相关的 CLAUDE.md（根目录和改动文件所在目录）。
3. 用一个小模型概括这次改动。
4. 并行派出几个审查者，各自看整个 PR：CLAUDE.md 合规、只看改动本身的明显缺陷、结合 git blame 与历史、以前 PR 的评论、代码注释里的约束。
5. 每条问题再交给一个独立的打分代理，按 0 / 25 / 50 / 75 / 100 的标准给出 0–100 的置信度；因 CLAUDE.md 报出的问题，要核对 CLAUDE.md 确实点名了它。
6. 低于 80 分的丢弃；一条都不剩就不发评论。
7. 误报清单：变更前就存在的问题；看起来像缺陷其实不是的；资深工程师不会提的吹毛求疵；linter、类型检查、编译器能发现的问题；泛泛的质量意见（测试覆盖、文档、一般安全建议），除非 CLAUDE.md 要求；代码里显式忽略的；很可能是有意为之、与本次变更直接相关的行为变化；不在本次修改行上的问题。

官方托管的 Code Review 也是多个 agent 按问题类别并行、看 diff 和周边代码，按代码实际行为验证每条发现，再去重，按 Important / Nit / Pre-existing 分级；`/security-review` 对每条发现并行过滤误报，只保留置信度 8/10 以上的。

## 5. 重构后的流程

### 完整评审

1. **按模型定预算**：本机模型（qwen、apple）一组约 4000 字符 diff、整个 prompt 约 1.9 万字符；远端模型和 CLI 一组约 4.8 万字符、整个 prompt 约 10 万字符。网关只对 PR 评审把 prompt 上限从 2 万放宽到 12 万字符，其它用途仍是 2 万；评审各处按自己的模型预算装配。
2. **分组**：按路径排序，同一目录的文件相邻，测试文件紧跟被测文件；小文件整份合组；超过一组容量的文件在 hunk 之间切开（单个 hunk 就超过时才在 hunk 内切），最后一段与后面的文件同组。大多数 PR 用远端模型一组读完，也就是 pr-agent 和 Claude Code 的“整个 PR 一次看”。
3. **梗概**：需要分几组、且不是本机模型时，先用一次调用写出整个 PR 的梗概（做了什么、按模块的主要改动、需要跨文件核对的地方），各组都带上。这对应 Claude Code 第 3 步“先概括改动”。
4. **每组的 agent**：先读取组内文件在源提交上的内容，给每个 hunk 上方补 3 行、再往上 10 行内找到所在函数或类的开头就补到那里、下方补 1 行（pr-agent 的动态上下文），补进来的只作上下文，问题仍只能定位到变更行；然后带上本组完整 diff、梗概、其它变更文件清单、评审规则、仓库规范（根目录的 CLAUDE.md、AGENTS.md）、已有评论和决策证据；可以用 `read_diff` 读别组文件（或本组大文件的其它段）的变更、用 `read_file` 读源码、检索决策。系统提示词写入 Claude Code 的误报清单和“宁缺毋滥”。每组各自有 10 分钟时限，一组超时不影响其它组。远端模型和 CLI 最多 3 组同时评审（pr-agent 并行处理各块，Claude Code 并行派审查者），结果按分组顺序汇总，执行记录里每一步标明来自第几组；并行的组之间不传递结论，靠梗概对齐。本机模型逐组进行，后一组带上前几组的结论。一组失败或 PR 有新提交时不再开始新的组，已经在评的组照常评完。勾选“深度评审”时（Claude Code 的并行审查者），每组同时派两位审查者：一位只找缺陷与安全问题，一位只核对团队评审规则、仓库规范和仍然适用的历史决策，每条问题都要写明依据（只是缺少结构化范围的决策由它自行判断是否适用，适用且变更行明确违背时照常报问题，拿不准的仍只作待核对事项；它还读得到记在其它项目下的决策，排在本项目之后，只有原文点名本仓库、属于跨仓约定或通用工程做法时才作为依据，明确记录过范围、判定不适用的仍然排除）；两边的问题一起去重、核验，任一位没评完，这组就不算评完。
5. **合并**：同一文件同一侧 3 行以内、标题相同的问题算一个，保留更高的优先级和两边的决策引用。
6. **核验**（Claude Code 第 5、6 步）：把问题连同附近的 diff（放得下时是整个文件的 diff）和它引用的决策明细交给模型，按 0–100 的标准和误报清单打分（依据决策或仓库规范的问题与规则点名的问题同档，须核对决策确实点名了它且适用条件成立），本机模型每次 3 条、远端每次 8 条（最多 3 次同时进行）。低于 80 分的移出问题列表，放进报告里可展开的“核验未通过的候选问题”，附分数和理由；核验调用失败的问题照样保留并提示。
7. **报告**：摘要以梗概开头，写明分几组、形成几条问题、几条经核验未列入，再附各组结论。

### PR 概览（`/describe`）

- 整个 PR 放得下时一次调用。放不下时按文件大小分成最多 3 块（远端模型和 CLI 各块同时写），每块只写逐文件说明和一段摘要，最后用一次调用根据各块结果写出类型、摘要和评审关注点（pr-agent 大 PR 模式的做法）。
- 输出是结构化的（类型、摘要、逐文件说明、关注点），由程序排成 Markdown。每个变更文件都会出现在说明表里，模型漏掉的列为“未单独说明”（pr-agent 的补全做法）；锁定、生成文件和没有文本 diff 的文件另外写明。

### 改进建议（`/improve`）

- 按和评审相同的分组生成（远端同时生成），每组最多 3 条；超过 3 组时取变更最多的 3 组，并写明其余没有给出建议（pr-agent 会静默丢弃，这里说出来）。
- 程序核对每条建议引用的原代码：必须在本次 diff 的新版本里连续出现，且至少包含一行新增代码，否则丢弃。这样可以防止引用不存在的代码，或去改旧代码。
- 一次自评调用对照 diff 给全部建议打 0–10 分（只加注释、文档、类型标注或日志的记 0 分），保留 5 分以上的最多 6 条，按分数排序；9 分以上标“高”，7 分以上标“中”。自评失败时按生成时给的重要度排序，并写明。

### 追问与复评

- 按预算装配：对话最多占四分之一，上下文最多占五分之二，diff 用剩下的空间。diff 放不下时每个文件都保留一部分，并写明还有几行没列出。所有长度都按 JSON 转义后的实际长度算。
- 复评在重启后也能从磁盘缓存找回评审规则和已有评论。

## 6. 取舍与没做的

- **按问题类别并行审查者只作为可选项**：Claude Code 和 Qodo 默认就派多个专职审查者，但调用数会成倍增加。这里默认由每组的一个审查者同时看缺陷、团队规则和历史决策，核验阶段专门核对“规则、仓库规范或决策确实点名了这个问题”；需要时在准备页勾选“深度评审”，每组再派一位只看规则与决策的审查者（没有像 Claude Code 那样再拆出 git blame、以前 PR 的评论和代码注释几位，这些材料 Decision 暂时没有或已放进已有评论里）。
- **核验仍是模型的判断**：Greptile 的数据说明，让模型给自己的评论打分接近随机。这里的核验是独立的一次调用，附上 diff 证据，并按 Claude Code 的标准逐条打分，不是让评审员自评；但它仍是模型判断，所以被移出的问题留在报告里可以看到，也可以对保留的问题再用“复评”。
- **评审者的反馈（已补上）**：Greptile 改用团队对评论的反馈过滤后，评论被处理的比例从 19% 升到 55% 以上。这里评审者可以对问题点“不采纳”并写原因；同一仓库以后的评审把最近的不采纳（远端 20 条、本机 5 条）告诉审查者，核验时与之同类的候选打 0 分并移出。发布成 PR 评论的问题反过来当作正面信号：同一仓库以后的评审告诉审查者团队在意这类问题（只给标题和文件，条数上限同上），核验时同类候选不因“像吹毛求疵”打低分，但仍须证据确凿。没有做 Greptile 的向量相似度匹配（同类与否由核验模型判断）。
- **本机模型**：4096 token 的上下文仍只能小组评审，没有梗概，核验每次 3 条。要读整个 PR，请选远端模型或 CLI。
- **hunk 上下文扩展（已补上）**：和 pr-agent 一样在 hunk 前后补几行并回溯到所属函数头，但只读新版本（源提交）的文件，每个文件一次请求（客户端按提交缓存，文件查看器共用）；补上的行最多占组容量的三成，按 hunk 顺序补到放不下为止，之后的 hunk 只给原 diff，所以本机模型的小组也能补上一部分；源码读不到时退回原 diff。更远的上下文仍由模型按需用 `read_file` 读。
- **没有做资格检查**：Claude Code 会跳过已关闭、草稿或已评审的 PR。Decision 由评审者自己选 PR，已合并的 PR 也允许回看。

## 7. 验证

- 新增 `pr-review-plan.test.ts`（分组顺序、hunk 切分、大文件分段、渲染层估算与实际分组一致、diff 压缩、跨组去重）。
- 评审服务测试新增：
  - 核验移出低分问题、核验失败时保留问题；
  - 远端模型先写梗概再分组；
  - 跨组读取和去重；
  - PR 概览一次写完和分块汇总；
  - 改进建议的引用核对与打分过滤；
  - 大 PR 上追问与复评的 prompt 不超过预算；
  - 远端模型最多 3 组同时评审、按分组顺序汇总，本机模型逐组并带上前几组的结论，一组失败后不再开始新的组，PR 概览各块同时写；
  - 补上下文按剩余容量逐个 hunk 取舍；
  - 审查者和核验都收到以前不采纳的问题，同类候选被移出，本机模型只带最近 5 条。
  - 审查者和核验都收到以前发布成评论的问题，本机模型只带最近 5 条。
  - 读取 PR 时从源提交读根目录的 CLAUDE.md、AGENTS.md，跟随 `@` 引用并去重，交给审查者和核验；读取失败时提示，下次打开重读；误报清单补上“规则或规范点名、但代码里显式忽略的”，并要求遵守变更行附近代码注释写明的约束。
  - 核验收到候选问题引用的决策明细；深度评审里只有规则与决策审查者自行判断缺少结构化范围的决策是否适用，也只有它读得到记在其它项目下的决策，明确记录过范围的仍然排除。
- 面板测试新增：`/describe`、`/improve` 走独立流程，报告里列出“核验未通过的候选问题”，准备页的分组数随所选模型变化；不采纳一条问题（带原因）后它收起、下次评审同一仓库时带上，撤回后恢复；只取同一连接、同一仓库里评审者本人的不采纳，最新的在前。发布一条问题后，下次评审同一仓库时准备页写明、请求里带上它的标题和文件；后来又不采纳的不算。

## 来源

本机：

- `~/git/code-meeseeks`（`packages/pr-agent-bridge`、`apps/desktop/src/main/services/pr-agent`、`packages/agent`）
- `/Applications/Code Meeseeks.app/Contents/Resources/pragent/`（pr-agent 0.39.0：`algo/pr_processing.py`、`tools/pr_reviewer.py`、`tools/pr_description.py`、`tools/pr_code_suggestions.py`、`settings/*.toml`）
- `~/.claude/plugins/marketplaces/claude-plugins-official/plugins/code-review/`、`plugins/pr-review-toolkit/`

网络：

- https://github.com/qodo-ai/pr-agent/blob/main/pr_agent/algo/pr_processing.py
- https://github.com/qodo-ai/pr-agent/blob/main/pr_agent/settings/configuration.toml
- https://docs.pr-agent.ai/core-abilities/compression_strategy/
- https://github.com/qodo-ai/pr-agent/blob/main/docs/docs/core-abilities/self_reflection.md
- https://github.com/qodo-ai/pr-agent/blob/main/pr_agent/settings/code_suggestions/pr_code_suggestions_reflect_prompts.toml
- https://github.com/qodo-ai/pr-agent/blob/main/pr_agent/tools/pr_description.py
- https://docs.qodo.ai/code-review
- https://www.coderabbit.ai/blog/how-we-built-cost-effective-generative-ai-application
- https://www.coderabbit.ai/blog/how-coderabbit-delivers-accurate-ai-code-reviews-on-massive-codebases
- https://github.blog/changelog/2026-03-05-copilot-code-review-now-runs-on-an-agentic-architecture/
- https://github.blog/ai-and-ml/github-copilot/60-million-copilot-code-reviews-and-counting/
- https://cursor.com/blog/building-bugbot
- https://www.greptile.com/blog/make-llms-shut-up
- https://www.nsbradford.com/blog/how-we-built-ellipsis
- https://www.sourcery.ai/blog/improving-llm-responses
- https://www.uber.com/blog/ureview/
- https://arxiv.org/html/2405.13565v1
- https://alignment.openai.com/scaling-code-verification/
- https://github.com/anthropics/claude-code/blob/main/plugins/code-review/commands/code-review.md
- https://code.claude.com/docs/en/code-review
- https://github.com/anthropics/claude-code-security-review/blob/main/.claude/commands/security-review.md
