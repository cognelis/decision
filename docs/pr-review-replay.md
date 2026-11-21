# 真实 PR 回放

回放复用正式的 `PrReviewService`、`ProfiledModelGateway` 和 Codex CLI 适配器。代码只从本地 Git 的固定提交读取，不切换分支、不读取工作区修改、不获取最新远端，也不发布评论。

## 准备历史样本

从平台记录 PR 标识、原始目标提交以及**问题尚未修复时**的源提交。在本机已有仓库中准备定义：

```sh
npm run replay:pr -- prepare \
  --repository /absolute/path/to/repository \
  --reference 'OWNER/REPO#123' \
  --head FULL_HEAD_SHA --target FULL_TARGET_SHA \
  --title '评审时的 PR 标题' \
  --output out/pr-review-replay/sample/case.json
```

`prepare` 计算 merge-base 并验证 Git 对象存在。可加 `--path path/to/file.ts` 只评审某个变更文件；工具仍可搜索整个固定版本仓库作为上下文，结果记录所选范围。省略则评审整个 PR。

定义仅包含仓库路径、提交、标题及可选范围，不接受缺陷答案。默认不带描述、平台评论、当前决策库或反馈，避免把后续讨论和修复提示泄漏给模型。需补充当时描述时，只在 `pr.description` 中填写经时间核实的内容。Git 对象需持续保留，否则历史样本无法回放。

建议将私有仓库样本、标签和输出放在已忽略的 `out/pr-review-replay/`；不要提交私有源码、原始讨论或令牌。

## 运行

```sh
npm run replay:pr -- run \
  --case out/pr-review-replay/sample/case.json \
  --executable /absolute/path/to/codex \
  --cache-dir out/pr-review-replay/vite-cache \
  --output out/pr-review-replay/sample/run-1.json
```

使用现有 CLI 登录。运行会将所评审的源码交给该登录对应的模型服务；只对已获准用于该服务的仓库运行。可以用 `--model MODEL` 固定可用模型；默认沿用 CLI 默认模型，结果记录为 `codex-default`。要做严格跨版本比较应显式固定模型，并保留调用记录中的模型信息。

默认后端是 Codex CLI。加 `--provider claude-code` 改用 Claude Code CLI 适配器（`--executable` 指向 `claude`），未指定 `--model` 时结果记录为 `claude-default`，便于同一样本做跨模型比较。

`--implementation /absolute/path/to/baseline` 可加载另一份代码快照的评审实现；该目录需要相同依赖和源码结构。结果保存实现路径、关键实现文件哈希、case 哈希、候选、最终报告、过程、用量与耗时。旧实现没有候选观测钩子时，从最终问题和过滤项恢复，并标为 `final-and-filtered`，不能据此统计更早的定位丢失。

实现目录只读或 `node_modules` 位于受限 worktree 时，可用 `--cache-dir` 将 Vite 临时缓存放到可写的隔离目录；省略时仍使用实现目录下的 `node_modules/.vite`。

### 决策与评审规则夹具

默认回放不给历史决策（`search_decisions` 一律无结果）、不带评审规则，只测找缺陷这一面。要测「应用决策」，加 `--decisions FIXTURE.json`；要带评审规则，加 `--rules RULES_DIR`。

`--decisions` 的夹具是合成数据，格式与 `scripts/lab/context-run.mjs` 场景的 `seed.files` 相同：

```json
{"version":1,"synthetic":true,"files":[{"path":"Decision Journal/summarize/D-1-请求超时释放.md","content":"---\nid: D-1\n…"}]}
```

- `synthetic` 必须为 `true`；`files` 最多 500 个，`path` 必须在 `Decision Journal/` 下（不能用 `..` 跳出），同一路径不能写两次。
- 回放把这些文件写进一个新建的临时 Vault（`summarize`、`decisions`、`principles` 三个目录总会建好，空的也建），用 App 自己的 `DecisionContextRepository`、`DecisionScopeRepository`、`DecisionRelationRepository` 和 `DecisionContextService` 检索：笔记解析、关键词打分、适用范围、适用性、替代关系和生命周期都与 App 一致。评审结束删除临时 Vault。
- **与 App 的差别**：没有本机语义向量。App 在本机嵌入模型可用时，会在关键词结果之后补充至多 3 条按含义相近找到的记录；回放没有这一步，所以夹具里的决策要能被评审员会用的词搜到。
- 笔记最简单的写法是 `summarize` 来源（历史沉淀）：

  ```markdown
  ---
  id: D-1
  created: "2026-09-01"
  status: "accepted"
  selected_option: "请求超时后必须取消底层调用并释放连接。"
  project: "app"
  tags: ["synthetic"]
  supersedes: []
  superseded_by: null
  decision_scope: {"projects":["app"],"paths":["src/server"]}
  ---
  # 请求超时释放

  ## 决策
  请求超时后必须取消底层调用并释放连接。
  ```

- `project` 要写评审的项目名，即 case 里 `pr.destination.repository` 的最后一段（`local/app` → `app`）。
- 各种写法在 PR 评审里的结果（已用产品检索实测；评审只传本次的文件列表，不传技术层次和模块）：

  | 想要的情况 | 写法 | 检索结果 |
  | --- | --- | --- |
  | 适用 | `decision_scope` 的 `projects` 含本项目，`paths` 覆盖本次**全部**变更文件，测试文件也算（或不写 `paths`） | `scope_match`；有一个文件在 `paths` 之外（例如 `apps/desktop/test/` 下的测试）就是 `needs_review` |
  | 已被替代 | 旧决策写 `superseded_by: "<新决策 id>"` | `lifecycleState: superseded`，并带后继 |
  | 其他项目 | `project` 写另一个项目（`decision_scope.projects` 同） | `out_of_scope`；默认评审看不到，深度评审的「规则与决策」视角会看到，标 `otherProject` |
  | 路径不对口（前后端分属不同目录时用它） | `paths` 写别的目录，或 `excludedPaths` 排除变更文件 | `out_of_scope`，默认评审和深度评审都看不到 |
  | 需按条件判断 | 不写 `decision_scope`，或只限定 `layers`、`modules` | `needs_review`（理由写明「缺少完整的结构化适用范围」或「本次未明确技术层次／未指定模块」） |

  只用 `layers: ["frontend"]` 表达「前端的决策」时，结果是 `needs_review` 而不是 `out_of_scope`：要靠评审员按提示词「前端的决策不套到后端」自己判断。想让程序直接排除，就用 `paths`。
- 默认评审每次 `search_decisions` 取前 5 条、不含 out_of_scope；深度评审的「规则与决策」视角取 20 条、含其他项目，筛掉路径不对口的之后留 5 条。
- 结果文件记录 `decisionsFixture: {path, sha256}`；报告的 `evidence` 是评审员实际看到的决策，`findings[].decisionIndexes` 是问题引用的证据编号。

`--rules RULES_DIR` 是一个放评审规则 `*.md` 的目录，格式同 App 的 `userData/review-rules`（front matter 的 `applies_to` 下 `project`、`repo`、`target_branch` 是正则，另有 `priority`、`enabled`）。回放用 App 的 `loadReviewRules`、`matchReviewRules`、`combineReviewRules` 加载和匹配，`project` 是 `pr.destination.repository` 最后一个 `/` 之前的部分，`repo` 是最后一段，目标分支为空（写了 `target_branch` 的规则匹配不上）。结果文件记录 `rulesDirectory`。

输出文件不覆盖。中断用 Ctrl-C，评审停止后保存已完成结果；未完整评审以退出码 2 返回。每组沿用正式流程的调用数和 10 分钟时限。多次比较用不同输出文件，逐次运行，避免并发评测放大平台或模型限流。

## 人工判定与计分

真实缺陷标签放在独立文件，模型运行命令不读取它。示例：

```json
{"issues":[{"id":"null-caller","priority":"P2","evidence":"head 改为返回 null，未修改调用方直接访问属性；base 抛异常。"}]}
```

阅读输出的 `candidates`，按从 0 开始的编号填写人工判定：

```json
[
  {"candidate":0,"verdict":"true_positive","issueIds":["null-caller"]},
  {"candidate":1,"verdict":"false_positive","issueIds":[]}
]
```

同一真实缺陷被多条候选指出，召回只计一次。新发现的有效问题可先标 `true_positive` 且 `issueIds: []`，再核实是否扩充标签。作者在注释、PR 描述或测试里明确接受了这种行为的设计取舍（例如有意吞掉的草稿存储错误），在标签里加 `tradeoff: true`：它不计入硬缺陷召回，计分时用去掉这类条目的标签文件（`score` 的标签格式不接受该字段），另外单独报告它的候选与最终命中数。未判定的候选不自动算误报；计分会明确列出未判定数量。

```sh
npm run replay:pr -- score \
  --run out/pr-review-replay/sample/run-1.json \
  --labels out/pr-review-replay/sample/labels.json \
  --judgments out/pr-review-replay/sample/judgments.json
```

输出已知缺陷的候选/最终召回、核验损失、已判定最终问题的精确率、未判定数和成本。未判定数非零时指标不完整；空分母返回 `null`。当前工具提供单样本计分，不能将一两个 PR 的结果当作整体召回提升。

## 从评测集导出

评测集的样本由 agent 经 `paraself` MCP 录入（`record_review_benchmark_cases`），App 核对提交和行号后存在本机数据里，用户核对过才确认入集，见[评审协作方案](review-collaboration-design.md)的“评测集”一节。回放前把已确认的样本导出成上面的文件：

```sh
npm run replay:pr -- export-benchmark \
  --repository /absolute/path/to/repository \
  --output out/pr-review-replay/benchmark-dev
```

- 默认只导出开发集；留出集要显式加 `--split holdout`，只在决定是否采用某项改动时用。`--set defect` 或 `--set clean` 只导出一个集合。
- 每个样本一个目录：`case.json` 即 `run --case` 的输入，不含答案；`labels.json` 是 `score --labels` 的输入，只含计入召回的问题，证据里写了问题标题和位置；作者接受的取舍另存 `tradeoffs.json`，干净集的已知误报另存 `known-false-positives.json`。干净集的 `labels.json` 没有问题条目，它的意见要人判为有害、噪声或有效，再按集合汇总。
- `manifest.json` 列出这次导出的样本、每个问题的位置和修复提交。修复提交可用来做修复对照：用 `prepare --head 修复提交` 准备修复后的版本再跑一次，同一问题不该再报。
- 样本没有平台 PR 号时，引用写作 `benchmark/项目名#序号`。导出时逐个核对提交仍在本地仓库、改动不超过 2 MiB；输出目录已存在就拒绝，不覆盖。
- 读取的是 App 当前用户数据目录下的 `review-benchmark/`；实验沙箱或测试用 `PARASELF_USER_DATA` 指定别的数据目录。

按集合汇总计分：每个样本目录里先放回放结果 `run.json` 和人工判定 `judgments.json`（文件名可用 `--run`、`--judgments` 改），再运行：

```sh
npm run replay:pr -- score-benchmark --directory out/pr-review-replay/benchmark-dev --output out/pr-review-replay/benchmark-dev/summary.json
```

- 判定沿用 `score` 的格式。误报可以多写两项：`impact` 为 `harmful`（照做会引入错误或无谓改动）或 `noise`（无害但没价值）；`knownFalsePositive` 写它再犯的是 `known-false-positives.json` 里的第几条（从 1 开始）。干净集里判为 `true_positive` 的意见是“其实是真问题”，应转入缺陷集。
- 缺陷集汇总已知问题数、候选和最终命中数；干净集汇总最终意见数、有害、噪声、有效数和已知误报再犯数。一个集合计分的样本不到 20 个时只给计数，召回率、每 10 个 PR 的有害意见数等比率留空。
- 没有回放结果或判定的样本列在 `missing`，不计入。

## 本轮源码调查能力

评审和核验共用 `find_files`、`search_code`、`read_file`：按固定 SHA 枚举仓库，按文件/目录范围做字面搜索，支持 diff 基点和源提交源码。核验继承评审实际读取的源码，包含版本、位置和截断标记。

源码搜索每页最多扫描 60 个文件、约 20 处摘录，每文件显示前 3 处；文件查找每页最多 100 条。`nextOffset` 非空时应继续或缩小范围。文本搜索覆盖源码、配置和文档，排除常见生成文件；读取失败、目录截断和不支持均不等于没有命中。当前按平台逐文件取内容，大仓库宜先用路径查找缩小目录；若网络成本成为瓶颈，再引入本地固定版本索引。

GitHub 使用固定提交 Git tree，GitLab 使用固定 ref 的 repository tree，Bitbucket 使用目标仓库中的固定提交 files 接口；目录最多保存 20000 个文件，分页或平台截断会明确标为不完整。沿用认证、限流、取消和响应体上限。

核验已从 0–100 分加 80 分门槛改为 confirmed / rejected / needs_context 三态（见 IMP-122），回放结果里分别是 `report.findings`、`report.filtered`、`report.needsContext`；`report.unplaced`、`report.merged` 记录没能定位到变更行和合并掉的候选，`report.conclusions[].checked` 是各组写明的核对点。比较召回时把待核实单独计数，不算作最终问题。真实模型回放与人工计分完成前，不宣称召回率已经提升。

回放结果不记录 prompt 正文；`traces` 每项带 `promptVersion`，核验调用另有 `verify`：候选（编号、位置、标题、引用的决策编号）、这次调用带上的决策编号，以及核验员每条判定及其 `premises`；评审实现在核验前给出 `functions`、`callerSearch` 材料时，还记下它们各行所在的 `[path, side, 起始行, 结束行]`（不含正文）。`node scripts/lab/pr-verify-stats.mjs [--json] [文件或目录…]`（缺省读 `$DECISION_LAB_ROOT/pr-replay/runs-r7`）据此逐次统计：最终问题的前提有几条落在这两样材料上，待核实里程序降级、未核验、核验员自判各几条，核验调用的输入 token，以及核验输入是否缺了候选所引的决策；没有 `promptVersion` 的旧结果按 progress 里的模型调用对齐取末尾的核验调用，前提一栏记为未记录。要看材料正文，可以给 `--executable` 套一层把 stdin 另存一份的包装脚本。
