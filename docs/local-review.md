# 本地审阅（Local Review）

选一个本地 Git 工程，在代码行上写审阅意见，提交后后台 worker 逐条评估、按情况分组、修改、推分支并开 PR。执行方式与模型档案分别选择。

它和现有「PR 评审」方向相反：PR 评审是模型读别人的 PR、人决定发什么；本地审阅是人写意见、模型去改。

设计评审记录：`LR-D1`（2026-11-05）。下文的 B、F、H 编号指该报告的发现。

## 范围

做：

- 新增页面「本地审阅」：选工程目录，看文件和变更，在行上标记，批量提交。
- 后台 worker：评估与分组 → 逐组修改和提交 → 推送 → 开 PR，全程无需再确认。
- 任务列表：进度、每条意见的结论、每组的 PR 链接、失败原因、重试和取消。

不做（到时候再加）：

| 不做 | 什么时候加 |
| --- | --- |
| 审阅未提交的改动 | 确实有人要审工作区时；v1 固定在提交上，行号不会漂移 |
| 每写一条就触发 | 不加。逐条触发会一条意见一个 PR |
| 修改后的第二轮模型自审 | PR 上人工审发现漏得多时 |
| 项目级 `verifyCommand` | 需要用户指定独立验证命令时再加；依赖安装见下文 |
| 在 PR 评论里继续对话、按评论再改 | 第一版跑顺之后 |
| 审阅意见进入决策记录 | 要先走识别与方法论的设计，不在这里顺带做 |
| 多任务、多组并发 | 串行不够用时（`ponytail:` 注释写明） |
| 堆叠 PR（后一组建在前一组上） | 有依赖的条目现在放同组；同组常常过大时再加 |
| 修复中发现跨组依赖后自动重新分组 | 代理把该条标 `skipped` 并说明，用户重新提交；这种情况常见时再加 |
| Git LFS、submodule 内容的修改 | 改到 LFS 路径或 gitlink 时按高风险拦下 |
| TODO：Claude 原生 worker 改用 Claude Agent SDK，获得宿主侧逐个工具审批（`canUseTool`） | 任务对话上线后，看实际是否需要拦截工具调用。前提：`settingSources: []`；固定 `pathToClaudeCodeExecutable`；`spawnClaudeCodeProcess` 接回 `ManagedChildProcessRunner`；行为自检走同一 SDK 路径并重跑代理实测。Codex 原生不换 SDK：文档未提供自定义启动入口，会丢失进程管理与代理校验 |

## 概念

- **审阅会话**：一个工程 + 固定提交 `headSha` + 对比基线（默认当前分支与默认分支的 merge-base，保存 OID）。开始时固定，HEAD 之后再动也不影响它。工作区有未提交改动时提示「这些改动不在审阅范围内」，不阻止。detached HEAD 时 `baseBranch` 必须手填。
- **工程**：系统目录选择框返回路径后，主进程保存并发放 `repositoryId`。IPC 只接受这个 id 和属于它的会话、任务、组，不接受路径字符串。
- **意见**：`{ id, path, startLine, endLine, side, lineText, body }`。`id` 由主进程生成。`side` 是 `new`（`headSha` 上的行）或 `old`（基线上的行，只在变更视图里有）。`lineText` 存行的原文。
- **任务**：一次提交生成一个任务。任务先评估和分组，产生零到多个**变更组**。
- **变更组**：模型判断应该一起改、一起审的一批意见。一组一个私有副本、一个远端分支、最多一个 PR。

草稿写入本地，重启不丢。

## 流程与状态

任务只表示计划和调度，结果由各组汇总：

```
draft → queued → evaluating → running_groups → finished（带汇总：各状态组数、需要处理的项、已产生的远端结果）
                     └→ no_changes（没有采纳的条目）
evaluating 失败 → failed；用户取消 → cancelled；App 重启时发现的运行态 → interrupted
```

`finished` 可以包含失败、等待确认的组，界面和通知按汇总说明，不说成全部成功。

变更组（各自独立，一组失败或等待确认都不影响其它组，也不占住队列）：

```
pending → fixing → committed → pushing → opening_pr → pr_opened
             │         │           │          └→ pushed_no_pr
             │         │           └→ blocked（高风险改动，等用户）
             └→ no_changes
活动阶段 → failed | cancelled | interrupted
```

取消任务时停止出队，未启动的组记为 `cancelled`，已成功的组保持原状。取消不是回滚，不删远端分支，不关 PR。取消只等待当前任务的执行与账本收尾，不等待其它任务；阶段及完成回调不能覆盖已保存的 cancelled。

### 1. 提交前预检

点提交时同步检查，不过就留在草稿里并说明原因，不进队列：

- 解析推送目标：`pushRemote` 必须恰好一个 push URL（`git remote get-url --push --all`，已应用 `insteadOf`），协议只允许 ssh、https（测试可注入 file）。多个地址、`ext::`、其它协议都拒绝。在模型碰不到的用户原仓库读取并冻结这个 URL、credential.helper 列表和 core.sshCommand，作为本任务的主进程私有网络快照写入账本；凭据命令不返回渲染进程。
- 匹配平台连接：按站点、项目、仓库精确匹配 `PrConnections`，不只比 hostname。无匹配也能继续，结果是 `pushed_no_pr`，提交前告诉用户。
- `git ls-remote` 确认 `baseBranch` 在目标仓库存在。
- 所选 worker 的能力检查通过：Codex 原生要求 CLI 沙箱探测通过；Pi 要求安全文件层可用，命令探测失败只关闭命令工具（见安全边界）。

### 2. 准备私有副本

每次模型运行都用私有副本，不用 linked worktree（B1、B7）：

```
git clone --no-checkout --template= --separate-git-dir=<job>/<name>/git <repo> <job>/<name>/tree
```

- 目录在 `<userData>/local-review/jobs/<jobId>/`。本地 clone 走硬链接，不复制对象，跨卷时自动退回复制。
- 不在用户仓库里登记任何东西：不写 `worktrees/`，不建本地分支，不跑 prune。用户的工作区、索引、分支和仓库元数据全程不动。
- 主进程对副本的每次 git 调用都显式传 `--git-dir` 和 `--work-tree`，环境设 `GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=/dev/null`、`GIT_TERMINAL_PROMPT=0`，清掉继承的 `GIT_*`，并带 `-c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.attributesFile=/dev/null`。配置是空的，`.gitattributes` 引用的 filter、diff driver 没有定义，什么也不会执行。
- `tree/.git` 指针文件在模型运行后不可信，主进程不读它；模型对 `git/` 目录只有读权限（或没有权限）。

对用户原仓库的只读操作（读 blob、diff、status）同样用干净环境，禁 fsmonitor，diff 带 `--no-ext-diff --no-textconv`，设 `GIT_LITERAL_PATHSPECS=1`。文件内容一律 `git cat-file` 按 `<OID>:<path>` 读，不读工作区文件，这样符号链接不会被跟随（B4）。ref 用 `rev-parse --verify --end-of-options <ref>^{commit}` 解析后只保存 OID。Git 返回的路径按 NUL 分隔，不 trim。

### 3. 评估与分组

通过所选 worker 在只读阶段处理整批意见：

- 每条输出 `verdict: accept | reject | needs_input` 和 `reason`。评估要自己读代码核实，用户的意见不一定对，不要照单全收。
- 把 accept 的条目分组，每组有 `title`、`annotationIds`、`reason`（为什么放在一起，以及为什么能独立于其它组）。
- **分组原则写进提示词**：一个审阅者能当作一件事看完的放一组；同一根因、改同一处逻辑、或一条依赖另一条的必须同组；主题无关、能独立合并和回滚的分开。不要为了少开 PR 硬合，也不要逐条拆。

校验分两层（B8），输出 schema 对 `groups` 放宽，由业务代码判断：

1. **结论层**：每个输入 id 恰好一个合法结论，无缺漏、重复、未知。不通过就重试一次，再不过 `failed`。绝不把缺结论的条目当 accept。
2. **分组层**：记 accept 集合为 A。A 为空 → `no_changes`，忽略 groups。否则组数 1–8，每组非空，所有 id 属于 A，无重复，并集恰好为 A。不通过就退回 `[A]` 一组，保存原始分组和原因码。

分组方案和全部 pending 组一次落盘后才开始第一组。重试沿用这份方案，不重新评估。groupId、序号、分支名由主进程生成；模型的 title、reason 限长。

### 4. 逐组修改

每组一份私有副本，通过所选 worker 修改，只给本组条目，上限 45 分钟。Codex 原生沿用 workspace-write 权限；Pi 的写工具由宿主执行。输出 changedFiles（相对路径，删除列被删路径、重命名同时列旧新路径；不得声明缓存或构建产物），以及每条的 `outcome: fixed | partial | skipped`、`summary`，以及 `commitTitle`（单行）和 `verification`（跑了什么、结果、没跑的原因）。发现依赖其它组时该条 `skipped` 并写明。代理不提交、不推送、不碰网络。

主进程随后：

1. `git status --porcelain=v1 -z --untracked-files=all`。提交后（含提交回执恢复）重新以最终 HEAD 的 status 核对未提交路径，写入组 excludedFiles，并在界面及 PR 描述中列出；声明但未改动的忽略。交集为空 → `no_changes`，仍保留未提交清单。
2. 枚举 status 的实际文件改动，与 worker changedFiles 取交集；清空旧暂存后，删除用精确 index 条目操作，新增/修改仅对叶子文件或符号链接用 literal pathspec add，禁止把目录交给递归 add。暂存区真实 diff 的路径必须完全落在选中集合内，越界就从 HEAD 重建索引并停止提交；核对通过再 `git commit`（单行信息，身份用用户的 `user.name`、`user.email`，会话开始时从用户仓库读取并显式传入，不签名）。
3. 提交是临界区：取消不能跳过 OID 回执，提交完成或回包丢失时先核对本组 Git，再将提交事实与 cancelled/interrupted 状态一起落盘；回调不能覆盖已落盘的取消。持久化 `commitOid`、相对 `headSha` 的改动路径（含重命名两端）和 diff 摘要。限制文件数和总大小。之后状态为 `committed`，可以删 `tree/`，只留对象。

### 5. 全部组改完后统一推送和开 PR

选「先出产物再开 PR」（B10）：所有能完成的组都到 `committed` 或终态后，再按序推送和开 PR。这样重叠信息在创建时就完整，不需要 `updatePullRequest`，也不会和用户在平台上编辑的正文打架。代价是第一个 PR 晚一些，后台任务可以接受。

1. **高风险检查**：扫描固定提交相对 `headSha` 的真实 diff（解析文件模式，含重命名两端）。命中下列任一项 → `blocked`，界面列出文件：
   - CI 与自动化：`.github/`、`.gitlab-ci*`、`.gitlab/`、`.circleci/`、`azure-pipelines*`、`Jenkinsfile`、`bitbucket-pipelines.yml`；
   - Git 行为：按 basename 匹配任意深度的 `.gitattributes`、`.gitmodules`、`.gitconfig`、`.gitmessage`、`.git-blame-ignore-revs`，以及根级 `.husky/`、`lefthook*`；`.gitignore` 不单独拦截。重命名两端都检查。CI 规则仍按平台实际根路径匹配，不将任意嵌套同名目录当作工作流；
   - 模式变化：新增或改动符号链接、gitlink、新增可执行位；
   - LFS 路径。

   这是提示，不是保证：普通代码被现有 CI 执行的风险不靠路径清单解决（B3）。用户点「仍然推送」时，授权绑定 `groupId`、`commitOid`、命中清单和推送 URL，任一变化授权失效。
2. **重叠**：比较各组改动路径。有重叠就在相关 PR 描述里互相写明。相同文件只是冲突提示，不代表依赖。重试时晚开的 PR 会提及早开的，早开的不再更新。
3. **推送**：`git push <url> <commitOid>:refs/heads/<branch> --force-with-lease=refs/heads/<branch>:`。空的 expected 值表示只在分支不存在时创建，已存在就失败，不会覆盖任何东西。不用裸 `--force`，不带 tags，不递归 submodule。分支名 `paraself/review-<jobId>-<序号>`，用完整 id。真正推送和所有 ls-remote 统一使用受管网络入口：GIT_CONFIG_NOSYSTEM=1、GIT_CONFIG_GLOBAL=/dev/null，只通过 -c 注入冻结的 credential.helper、core.sshCommand，固定 protocol.allow=never、protocol.https.allow=always、protocol.ssh.allow=always，file 只能由测试注入；保留 hooksPath=/dev/null。不重新解释任何用户全局 include 或 URL rewrite。相对认证/SSH 命令只在原仓库的可信工作目录求值，绝不在模型副本里执行；ssh 带 BatchMode=yes；上限 5 分钟。
4. **开 PR**：`HostedPrClient` 新增 `findPullRequest`（按源仓、源分支、目标仓、目标分支）和 `createPullRequest`（GitHub、GitLab、Bitbucket Server），写操作接受 `AbortSignal`。GitHub 开 draft，GitLab 标题加 `Draft:`，Bitbucket Server 开普通 PR 并带配置的审阅人。跨 fork：GitHub 用 `owner:branch`，Bitbucket Server 用 `fromRef.repository`。没有匹配连接、或平台不支持（Gitee、GitLab 跨 fork）→ `pushed_no_pr`，界面显示分支名和原因。

PR 描述列出本组每条意见（`路径:行`、原文、结论、改了什么）、分组理由、`verification` 的原话，以及同一任务的其它组。本任务未采纳和待确认的条目写进**第一个成功创建的 PR**，界面上始终能看到。没跑验证就写没跑。Bitbucket Server 的标题和描述按码点去掉 4 字节字符，否则返回 500；去完标题为空时用固定标题。

### 6. 恢复与重试

外部动作前写 intent，完成后写 receipt；落盘失败就停止后续写入，不吞错（B5）。不用 `PrSnapshotStore` 这类会吞写入失败的缓存。

| 阶段 | 重试时做什么 |
| --- | --- |
| `fixing` 失败、取消、中断 | 确认进程已结束；若已有 commit intent，先从本组 Git 核对并记录 OID，不能删恢复来源。确认未提交才重建并重跑修改 |
| `committed` 之后 | 不再调用模型 |
| `pushing` | `ls-remote` 查该分支：等于 `commitOid` → 继续开 PR；不存在 → 推送；其它 OID → 报冲突，不覆盖 |
| `opening_pr` | 先 `findPullRequest`（含已关闭、已合并），没有才创建。平台回「结果未确认」时不盲重试，先查 |
| `pushed_no_pr` | 只重试开 PR |
| `pr_opened`、`no_changes` | 不可重试；清理失败单独记录，不把成功改回失败 |

本轮调度的 groupId 集合持久化到任务账本。初次运行包含全部计划组；单组 retry 或 approve 只运行选中的组，不顺带处理其它 pushed_no_pr、pending 或失败组。未启动组保留 pending，可由用户单独开始。

同一组的重试、确认、丢弃互斥，用 `attemptId` 防止旧回调覆盖新状态。

### 7. 退出与清理

- App 退出时：先设 closing 标志停止出队，再 abort 当前模型、Git 和平台操作，等待有界清理和账本写完，再停其它服务。活动阶段记 `interrupted`，pending 和已结束的组保持原状（B6）。
- 取消时进程组必须真正结束。**先修 `ManagedChildProcessRunner` 的现有缺陷**：父进程先退出时会清掉 SIGKILL 计时器，忽略 SIGTERM 的子进程活下来继续写文件（E6）。进程组回收要和父进程 close 解耦，补回归测试。
- 不建立任务级第二份对象库。`committed` 后只删除 `tree/`，保留本组 `git/`；取消后已有提交或待核对 commit intent 的组也保留 `git/`。发布成功、用户丢弃或 14 天过期才删除 Git 产物。未提交的 cancelled、no_changes 组删除全部副本。过期组标记为不可重试的 failed，原因固定为「产物已过期」；用户丢弃的组也不可重试。
- probe、evaluation、group 使用统一的主进程目录所有权清单：prepare 之前先将 jobId、固定目录名、种类、创建时间和 preparing 意图落盘，prepare 本身也在失败收尾保护中。清理区分 tree-only 与整个副本，失败保留清理目标和原因，以免重启时误删已提交 Git。
- 启动时对账 jobs/：未入任务账本的目录、已知任务下未登记的副本都会在 realpath 校验通过后清理；无变更组的失败 evaluation 同样适用 14 天期限。旧账本只按固定 probe/evaluation/group 身份收养既有目录，不遍历用户工程。
- 准备、提交、恢复、推送和删除前均校验真实目录仍对应已登记的物理路径；拒绝符号链接重定向，即使重定向到另一个任务也不删除。不接受来自渲染进程或模型的目录路径。

工程级设置（按仓库保存，有默认值，界面可改）：`pushRemote`（默认 `origin`，走 fork 时填个人远端）、`baseBranch`（默认会话开始时的分支）、`reviewers`（默认空）。

## 执行方式与模型档案

工程设置和任务分别保存 worker（codex / claude-code / pi）。旧账本默认 codex，重试使用任务原 worker，不按档案 kind 重新猜测。界面「审阅代理」区先选「执行方式」，再选「模型档案」：

- Codex CLI：原生执行，仅接收 codex-cli 档案，沿用原 CLI 工具与权限准入，探测失败禁止提交。
- Pi agent：接收所有已启用的生成档案，包括 HTTP、Claude Code CLI、Codex CLI；Apple 与 OpenRouter Decisions 不支持结构化生成，不列入；UI 和主进程入队前共用生成能力判定，预检拒绝时意见保留在草稿。模型走 ProfiledModelGateway，工具由 Paraself 执行。CLI 档案只提供模型输出，Claude 以空 tools 名单运行，Codex 文本模型通过公共内置目录关闭执行工具并拒绝工具事件；没有恢复 Claude 原生工具路径。
- Claude Code CLI 原生：仅接收 claude-code-cli 档案，使用 CLI 自带工具与严格内置沙箱。用户已接受钥匙串隔离未验证、Node 等间接执行 security 的风险；CLI 只拦截直接 security 命令。建议只用于信任的工程。

任务详情显示 worker、模型后端与模型；Pi 模型调用以 local-review purpose 进入 gateway 的现有调用/用量记录，不新建收费通道。评估分组、意见 ID、结果 schema 和提示词与 Codex 共用。

### Pi 宿主工具

默认 list_files/search_code 跳过 node_modules，避免依赖挤掉 5000 项额度内的源码；显式指定 node_modules 前缀才进入，read_file 仍可按明确路径读取。

评估只有 list_files / search_code / read_file；修改增加唯一字符串 edit_file、write_file、delete_file，命令准入成功后才增加 run_command。所有路径是 tree 相对路径，拒绝绝对路径、..、.git 及符号链接。目录句柄逐组件打开；原生 openat/mkdirat/unlinkat 在主进程内完成操作，O_NOFOLLOW 防止路径替换后跟随新链接，不依赖模型进程的权限。单文件文本 2 MiB、单次目录 5000 项、工具总输出 1 MiB；超长行可续读，未读/跳过项明确返回。

写工具自动记录 changedFiles。run_command 的产物不自动登记；最终仍由受控 Git 取实际路径交集、精确暂存及核对最终提交。必须通过 submit_result 提交业务结果，非法或缺失只有一次修正机会；结果通过后不再执行同批后续工具。Pi 使用与 PR 评审相同的 Agent 顺序调度/gateway 事件桥接，最多 6 次模型调用、8192 输出 token 请求上限及 19000/100000 字符上下文预算；取消贯穿 gateway 和命令进程组。

run_command 只接收 argv 数组，cwd 固定 tree，不经 shell 展开。主进程生成默认拒绝的 sandbox-exec 配置，系统运行路径与已验证具体工具链前缀只读，tree/scratch 可写，Git 元数据拒写；拒绝全部网络和钥匙串服务 Mach lookup。环境无凭据或代理，HOME/TMPDIR/XDG 指向 scratch，OPENSSL_CONF=/dev/null；单次最多 10 分钟，输出与进程组有界回收。

每个任务先做无模型固定命令探测，检查外部读/写、合成 HOME 文件读取、Git 写、网络 sink、钥匙串端口和 Node 正向控制。默认拒绝策略只额外允许根目录本身（literal，而非 subpath）的读取供 dyld 启动，以及明确列出的运行时 sysctl；不因此开放整个文件系统。命令可用时要求代理在修复前后运行本组现有测试并分别记录实际结果。任何断言失败或平台不支持时不提供 run_command，文件编辑继续，verification 由宿主加上“未执行命令测试”与原因；绝不无沙箱回退。与 Codex 原生探测失败关闭整个调用的策略分别展示。安全文件原生层当前覆盖 POSIX 平台；不支持的文件层不会退回不安全路径操作。

### Claude Code CLI 原生边界与已接受风险

执行方式与模型档案必须匹配。主进程生成并严格校验 settings，内联传入 CLI；不从模型可写目录加载 settings。固定 safe-mode、空 setting-sources、严格空 MCP、禁 slash commands、明确 Read/Glob/Grep/Edit/Write/Bash 清单和 dontAsk；不使用 bypassPermissions。评估拒绝 Edit/Write 与 tree 写入；修改只允许 tree/scratch 写入，Git 元数据始终拒写。Bash 使用内置沙箱，要求 enabled/failIfUnavailable，禁止无沙箱回退，网络域名全拒绝。/usr/bin 只列必要具体文件，不含 security；复用实际 Node/Python 工具链前缀和真实 Git 程序。

CLI 用既有真实 HOME 登录，不搬运或打印认证文件。TMPDIR/CLAUDE_CODE_TMPDIR 使用主进程创建、校验并清理的短别名，实际指向本组 scratch；缓存亦指向 scratch。认证环境变量通过 sandbox.credentials.envVars 隐藏。SRT 自行维护受限代理环境和 Git 配置变量，不能把“模型认证值隐藏”宣传为“工具环境里没有任何 proxy/key 字样”；工具断网由实际网络反例检查。

首次使用通过同一 argv/settings/environment 构造器、实际评估/修改业务 schema 真实运行两阶段自检，覆盖文件工具正反例、合成 HOME/父目录/符号链接、分阶段写入、Git 拒写、Node 测试、后台后代、Python、Git、网络 sink 和直接 security 拒绝。检查实际 tool_use/tool_result、主进程文件摘要和随机 nonce 的 Node 回执，不信模型的 ok。按可执行文件 realpath/大小/mtime、设置、业务 schema、平台、模型和认证路径/代理环境指纹缓存；变更后重做。未知工具、参数/回执不符、任何正向或反向失败都禁止提交，不回退。结构化业务结果沿用共同 schema；传给 CLI 时只去掉其不接受的根 $schema 方言声明，保留字段约束并在宿主用原 Zod 严格校验。缺失或非法只修正一次；传输/进程失败不作为格式问题自动重试。

用户明确决定：使用 Claude Code 自带工具；钥匙串隔离未验证，建议只用于信任的工程。CLI 拦截直接 security 调用，但 Node 等间接执行 security 的帮助已被实测可行；该风险已接受。Bash 中钥匙串服务可达，真实秘密是否可读未测，不把这两点称作已隔离。没有读取、写入或创建真实/测试钥匙串。共享令牌形态扫描只是推送前兜底，也不能证明凭据无法泄漏。

## 新增内容的敏感形态扫描

三种 worker 共用主进程关卡：生成固定提交后、推送前，扫描本组 diff 的新增行。固定规则识别 sk-ant- 前缀、明显的 auth.json/OAuth 令牌字段和钥匙串转储形态。命中后进入 blocked，只能丢弃，普通的「仍然推送」、重试和恢复都不能绕过；其它组仍可继续。扫描结果只包含文件与新行号，不附命中内容，渲染端的固定 diff 与模型修复说明也会移除，避免风险预览再次展示内容。

这是兜底规则，不证明凭据无法读取或泄漏。编码、拆分和未知形态可能漏检，合法源码/测试样例也可能误报；不以这层扫描替代工具隔离。

## 安全边界

Git 推送凭据仅由主进程使用；模型 CLI 自行使用现有登录。Codex 原生和 Pi 命令的 HOME、TMPDIR、XDG 均在本组 scratch；Claude 原生保留真实 HOME 维持认证，文件工具拒读认证配置路径，TMPDIR 与缓存指向本组 scratch。scratch 位于 tree/ 之外，两阶段都可写并随副本清理。工具环境设置 OPENSSL_CONF=/dev/null。Claude 原生的钥匙串与间接执行风险见下节，不能声称凭据只在主进程或钥匙串不可达。

- **默认模型**：档案未指定模型时不传 --model，沿用 CLI 默认模型；元数据从 debug models --bundled 的内置公共目录取得，不需要主进程读取用户模型缓存。显式模型保持原有目录验证路径。
- **Codex 的启动**：`--ask-for-approval never exec --ephemeral --json --ignore-user-config --output-schema <file>`、`-c features.plugins=false -c features.apps=false`，关闭 web、MCP、额外 agent、memory。环境走 `minimalClientEnvironment` → `ModelNetworkPolicy.cliEnvironment` → `ManagedChildProcessRunner`，不另造进程管理。评审确认不能直接复用 `codex-cli-adapter` 的临时工作区和 120 秒期限（F2）；组合 runner、环境、schema 转换，最终答案和工具日志各设上限。
- **工具链**：用 App 的 login-shell PATH 定位固定名单 `node npm npx pnpm yarn python3 go cargo`，解析 realpath（含已配置的 Volta/rustup shim）后，以规范化后的 HOME、程序和前缀做路径组件级包含检查，拒绝 HOME 及其祖先。只读目录仅认可具体版本化安装布局（Volta/nvm Node、数字版本 rustup toolchain、Homebrew Cellar、Python framework）；管理器根、聚合前缀及未知布局仅授权程序文件，不推断父目录。工具 bin 加入受管 PATH，工具因依赖不可读而无法运行时在 verification 如实写未跑，不放宽授权。快速探测同时执行已找到的 Node；Node 执行失败与金丝雀失败一样关闭调用。副本可按下文「项目依赖」准备 node_modules；准备失败时测试仍可能无法执行，verification 必须如实记录未跑原因（代码保留 ponytail 注释）。
- **读限制是这个功能的前提**（F1）。默认沙箱能读全盘。用 Codex permission profile，通过 `-c` 注入：

  ```toml
  default_permissions = "lr"
  [permissions.lr.filesystem]
  ":minimal" = "read"
  ":workspace_roots" = "read"   # 修改阶段是 "write"
  "<实际二进制文件>" = "read"
  "<实际 host / exec-server 文件>" = "read"
  [permissions.lr.network]
  enabled = false
  ```

  **不能同时传 `--sandbox`**：实测两者同传时命令成功，读限制却失效。schema 文件和提示词放在模型不可写的位置。git 目录的读权限只给本任务的 `git/`。
- **能力探测失败即关闭**：不设 CLI 版本白名单，不按版本字符串拒绝提交。每次模型调用（评估、逐组修改、重试）前都执行快速金丝雀：工作区读写、外部读写拒绝、Git 元数据拒写、应用自有受管目录中的程序样本可读而同目录旁路文件不可读，不向 CLI 安装目录创建文件。程序只按实际二进制、host、exec-server 与解释器文件放行，不放行它们的整个目录。当前 macOS 系统 Git 仍依赖 `/Library/Developer/CommandLineTools` 目录，该系统工具目录属于明确的信任范围。
- **正式 exec 自检**：首次使用或 CLI 指纹变化时，使用正式 argv 构造器、相同模型目录、权限、工具设置和 shell 环境，在实际副本的同一工作目录执行一次真实 exec，自检不得夹带探针之外的源文件修改。模型必须运行固定命令，把金丝雀读取的输出和退出码写到带随机 nonce 的工作区结果文件。主进程只检查这个文件：nonce 必须匹配、退出码非零、不含金丝雀内容；文件缺失、符号链接、FIFO 等非普通文件或内容不符都失败，不相信模型文字回答。成功按实际 executable/host 的 realpath、大小、mtime，权限/工具设置与模型目录哈希、平台缓存；快速探测从不缓存。程序或目录在自检过程中改变也拒绝继续。
- **两条入口保持受管**：正式 exec 保留 `--ignore-user-config --ignore-rules`；本机 sandbox 子命令不接受这两个参数，因此快速探针用临时空 CODEX_HOME 消除用户配置，并用 env -i 构造同一 shell 环境，显式注入全部受管配置；sandbox 直接命令不加载 execpolicy rules。配置不兼容给出可读的探测失败原因，绝不退回默认沙箱，平台限制不变。
- **工具清单上限**：当前 exec JSONL 不提供完整工具 manifest。遇到未知工具事件失败关闭；未公布的工具入口不能由日志证明不存在。`ponytail:` 上限写在代码：exec 自检只覆盖命令工具路径，code-mode 直接入口依靠独立测试和实跑覆盖，不能把一次 nonce 检查称为所有未来工具的保证。
- **主进程不执行副本里的任何东西**：见「准备私有副本」。这一条要用反例验收：副本里放 clean/smudge filter、fsmonitor、textconv、includeIf、hooks，全部写标记文件，断言都没写（H2）。
- **模型可见范围**：副本含 `headSha` 的完整历史，不只是当前提交。提交按钮旁写明：相关源码、完整 Git 历史和意见会发给所选档案对应的模型服务。
- **推送会触发远端 CI**：draft 不阻止这一点。提交按钮旁一并写明。

## 落点

| 位置 | 内容 |
| --- | --- |
| `packages/protocol` | 工程、会话、意见、任务、变更组、工程设置的 zod schema，`DecisionApi` 与 IPC 通道 |
| `apps/desktop/src/main/local-review-git.ts` | 受控 git 执行：原仓只读、私有副本、提交、推送、远端解析，参数数组直接执行、`shell:false`，复用现有进程组 runner（Git 是非模型网络路径） |
| `apps/desktop/src/main/local-review-agent.ts` | 评估和修改的 Codex 调用：参数、permission profile、能力探测、输出解析 |
| `apps/desktop/src/main/local-review-service.ts` | 账本（`atomicWrite`，写入串行化）、串行队列、状态机、校验、恢复、退出 |
| `apps/desktop/src/main/pr-platform-client.ts` | 新增 `findPullRequest`、`createPullRequest`，写操作支持 `AbortSignal` |
| `apps/desktop/src/main/model/cli/managed-child-process.ts` | 修 B6 |
| `renderer/components/pages/local-review/` | 页面。抽出 `PrDiffDialog` 与 `pr-diff-view.ts` 的通用展示部分，注入固定提交的读取接口 |
| `renderer/preview-api.ts` | 预览实现 |

通知沿用 `reviewReminderNotifier` 的持有、点击、重挂模式，但用独立分组和任务导航。

上限：一个任务最多 50 条意见，单条 4000 字符；评估 15 分钟，每组修改 45 分钟，Git 操作 5 分钟，到时取消并 `failed`。

## 验收

- **单元**：任务和变更组状态机每条转移；分组校验（漏条、重复、未知 id、`accept=[a] reject=[b] groups=[[a,b]]`、空组、超组数退回一组；结论缺失不退回而是失败）；授权绑定；高风险扫描；`findPullRequest`、`createPullRequest` 三个平台的请求体和 4 字节字符处理。
- **Git 反例**：filter、fsmonitor、textconv、includeIf、hooks 都不执行；多 pushurl、`ext::` 被拒；已有分支不被更新；`:(exclude)` 这类路径不被当 pathspec；符号链接不被跟随。
- **进程**：B6 的回归用例，含忽略 SIGTERM 的子进程。
- **故障序列**（B9），每个都断言已成功的组没有新增模型调用、推送、PR：G1 成功 G2 失败 G3 成功；G1 blocked 而 G2 继续；G2 执行中取消；推送成功但回执丢失后重试；创建 PR 后回包丢失再重试；PR 成功后清理失败；分组落盘后创建 G1 时崩溃；重启时只有 G2 活动。
- **端到端（测试内）**：临时 Git 仓库 + 本地 bare 远端 + 假 `codex` 可执行文件 + 本地假平台服务器，走完一个分成两组的任务，断言开出两个 PR、用户仓库字节不变（含 `.git`）、远端两个分支内容各自正确、PR 请求正确、副本被清理。
- **实跑复验**：`scripts/lab/local-review-run.mjs --labels <原冻结 expected-labels.json> --root <新目录>` 原样复制冻结标签，并从其旁边的 source 仓库检出固定 head；新意见 ID 单独映射，不改标签。除 verdict/语义分组和单组冻结测试外，检查三组提交双向两两合并、合并后的全套测试、提交无缓存，并从真实命令事件及 TAP/测试统计核实代理确实执行测试。
- **实跑**：隔离 App（`scripts/lab/isolated-app.mjs`）+ 一次性合成仓库 + 真实 Codex，走一次全流程，含分组质量和读限制金丝雀。不碰用户真实数据，不向真实平台开 PR。

## 项目依赖

私有副本只有 Git 跟踪的文件，没有 `node_modules`，真实工程的测试跑不起来。任务开始时，在模型启动之前为工程准备依赖，让三种 worker 都能真跑测试。

用户要求：项目之间互不影响，不影响 Paraself。

### 触发与配置

工程设置新增「依赖安装」：

- `auto`（默认）：按 `headSha` 上的 lockfile 选命令。`package-lock.json` → `npm ci`，`pnpm-lock.yaml` → `pnpm install --frozen-lockfile`，`yarn.lock` → `yarn install --immutable`。多个 lockfile 或都没有 → 不安装。
- `custom`：用户填 argv（一行一个参数，不经 shell）和用于计算缓存键的文件列表；用于自定义 Node 工程的安装命令，产物仍是根 node_modules。
- `off`：不安装。

另有「允许安装脚本」，默认开，关闭时给 npm、pnpm、yarn 加 `--ignore-scripts`。默认开是因为许多工程依赖 postinstall，而安装发生在模型之前，内容是用户自己提交的 `headSha`，等同用户本地安装，还多一层沙箱。

### 流程

1. 任务评估通过、有变更组后，进入 `preparing_dependencies`。
2. 缓存键：`repositoryId` + 命令 + 允许脚本开关 + lockfile 与根 package.json 内容哈希 + Node 版本和平台。命中就跳过安装。
3. 每次准备使用一次性 `<userData>/local-review/runs/<runId>/`：临时副本、HOME、TMPDIR、XDG 与包管理器 cache/store 均在其中。`runId`、工程 ID 和随机沙箱指纹在主进程 0600 账本中先落盘，再启动任何安装沙箱；命中缓存跳过安装，未命中从 `headSha` 的副本安装。
4. 安装结束后先确认全部沙箱后代已经退出，再校验根 `node_modules`：只接受普通文件、目录和不逃逸产物根的符号链接，拒绝 FIFO、socket、设备、不可读目录、过深或超限产物。主进程逐文件克隆为新 inode 到 `dependencies/<repositoryId>/published/<缓存键>/node_modules`，不把安装目录 rename 过去，也不保留源硬链接关系。完成标记仅由主进程在发布目录最后写入；没有标记的目录作废。随后删除本次 run。
5. 每组副本 checkout 后，用 APFS 写时复制（`cp -c -R`，不支持时退回普通复制）把产物克隆进 `tree/`。模型或测试改动 `node_modules` 只影响本组。
6. 产物路径不在 `.gitignore` 里时，这个工程不克隆依赖，verification 写明原因，防止依赖出现在 status 里干扰判断。提交仍走「只提交声明文件」。

安装失败、超时或探测不过：任务继续，不带依赖运行，verification 写明，界面显示日志入口。这和 `run_command` 的退化路径一致，依赖是验证能力，不是修改的前提。

### 隔离

项目之间：

- 已发布缓存只放在 `dependencies/<repositoryId>/published/`。安装沙箱对所有 published 目录均无读、写权限，包括同工程的其它缓存键；脚本不能伪造完成标记或篡改历史缓存。
- 沙箱写权限仅给本次 `runs/<runId>/`，不再有跨安装共享的可写工程 cache。npm、pnpm、yarn 的 cache/store 随 run 删除；lockfile 变化时重新下载，不复用用户全局缓存。
- 统计、校验与清理错误按工程隔离，异常缓存作废并记录原因，不中断 App 启动或其它工程的扫描。缺少随机指纹的旧 run 或旧缓存无法安全归属，启动恢复时保留记录和目录，仅阻断该工程的依赖发布；不再退回路径权限判据，不推断其进程可被终止。用户显式“清除依赖缓存”时，可只删除这些目录与记录并记日志，不发送信号；清理数据不代表已终止未知进程。启动时重试账本未完成 run 的回收，再清理 runs 中遗留目录；回收失败保留该 run 和原因、拒绝该工程继续安装，文件修改仍可进行。

与 Paraself 之间：

- 安装仍通过 `ManagedChildProcessRunner` 启动，但不只回收进程组。每次 run 用 CSPRNG 产生 32 个独立、仅含随机值的 Mach 名称及随机允许/拒绝位，两种取值均不少于 8 个。名称不注册服务，没有可预测前缀；它们只用于核对授权，不调用真实 Mach 服务。最初的未创建文件路径方案经本机 SPI 实验不可用，用户明确裁决改用这些随机名称。
- 只有已沙箱化、对全部 32 个名称的 `sandbox_check(mach-lookup)` 决策完整一致的进程才归属本 run，不再根据 run 根和父目录的权限形状判断。任何查询失败或结果不确定都不授权终止；扫描不能完成时拒绝发布，并保留恢复记录。
- 指纹仅存主进程 0600 账本与安装沙箱不可读的 0600 配置。配置放在 run 之外，经 sandbox-exec -f 先读取再进入沙箱；不把规则内联进命令参数或写入 run。允许和拒绝规则在基础规则后按名称明确列出。
- 安装前及重启回收前，实际启动四个自建沙箱作准入检查：默认允许、默认拒绝、R8 的父目录 literal 配置都不得匹配，同指纹沙箱必须匹配；失败就拒绝安装或回收，不退回其它判据。探针只按直接创建的受管进程身份清理。
- 原生发信号前完整复核 32 位、UID 与出生时间，并在发信号前一刻再复核一次。单个候选返回 false 或 EIO 时仍继续完整复核并处理其它候选，但整轮最终判失败、不发布；不会因它跳过其它后代。PID 复用在最后一次检查与 kill 之间仍有非原子窗口，作为 ponytail 剩余风险保留，不宣称已消除。
- 成功、失败、取消、App 退出均循环清扫包括 detached/setsid、关闭 stdio 和双重 fork 的后代，连续三个空快照才继续。发布前不能确认没有存活后代，就不发布；下次启动按账本 runId 再清扫。
- 环境白名单：无 API 密钥、令牌、`NPM_TOKEN`、`PARASELF_*`、Git 凭据。设 `PARASELF_PROVIDER_CHILD=1`，HOME、TMPDIR、XDG 指向本次 run 目录。不读 `~/.npmrc`。
- 不碰 App 自身的 `node_modules`、userData 其它内容、Vault、用户工作区。
- 主进程不执行安装产物里的任何东西。

沙箱（`sandbox-exec`，主进程生成）：

- 读：系统运行目录、固定工具链前缀和本次 run。拒绝 HOME 其它部分、其它 run 及所有已发布缓存。
- 写：仅本次 run 和 `/dev/null` 等运行时文件；本次副本的 Git 元数据仍然拒写。
- 网络：仅出站。不许监听。本地审阅其余阶段的工具仍然无网络。
- 主进程对选中工具用 `otool -arch <本机架构> -l` 读取 Mach-O 加载命令（包含 `-L` 同源的依赖名和 LC_RPATH），递归解析非系统动态库；支持 `@rpath` 的加载链搜索栈、`@loader_path`、`@executable_path`。系统 `/usr/lib`、`/System` 库由既有系统权限处理，不扫描 dyld shared cache。
- 库均取 realpath：仅为 Homebrew `Cellar/<包>/<版本>` 授权对应版本目录，未知布局只授权库文件；加载路径上的符号链接只用 literal，不对 `opt` 别名给 subpath。绝不放行 Homebrew、全局 node_modules 或 HOME 整根。Homebrew 将 npm 的 JS 实现放在 keg 外时，仅识别精确的 `lib/node_modules/npm` 运行包，不能扩展为其它全局包；这与动态库的文件授权分开。
- 每个工具最多 200 个非系统镜像（含工具本身）、4000 条依赖边、64 层加载链；每镜像最多 64 个 rpath，累计搜索路径最多 256；符号链接最多 40 跳。每次 otool 最多 5 秒/2 MiB 输出，闭包预算 30 秒。未知路径、缺失库、解析错误或超限均禁用该工具并给出原因，不换宽目录重试；Volta 等已选中工具不切换到另一个 Node 版本。
- 相同工具发现结果用于安装和 Pi run_command。Codex、Claude 原生配置同步获得规范化的版本目录和文件，不把 opt 目录别名交给原生客户端扩大为子树权限。只增加读范围，不增加写、网络或宿主工具能力。本机 Codex 自身生成的策略仍会拒绝 Homebrew opt 链接的 metadata（额外只读实测）；原生客户端的固定自检会继续拒绝这类组合，不为兼容它而开放 opt 父目录。共享安装/Pi 策略具有逐链接 literal 授权，已单独验证 Homebrew 正向执行。
- `ponytail:` 这是静态加载闭包，不预先授权未声明的运行时 dlopen 插件。发现后的包升级仍可能使路径失效，实际沙箱准入与命令失败会照常退化，不授予祖先目录兜底。
- 工具环境统一设 `SSL_CERT_FILE=/etc/ssl/cert.pem`，使用系统根证书且保留证书校验。本机 Homebrew Node 默认使用 OpenSSL CA store，其 keg 外的默认 CA 文件可能被沙箱拒绝；不以放行 Homebrew etc 目录来修复。安装沿用已有系统 CA 读范围，Pi 显式只读该证书文件。
- App 启动环境若有 `NODE_EXTRA_CA_CERTS`，工具保留其原始值，仅为这个绝对路径的普通文件及其规范路径增加只读；不授权证书目录或兄弟文件。相对路径、缺失文件或目录设置拒绝准入，不从模型或工程配置扩大信任。原生客户端接收相同的文件权限与工具环境。不会设置 strict-ssl=false、NODE_TLS_REJECT_UNAUTHORIZED=0 等关闭验证的选项。
- 拒绝钥匙串相关 Mach 服务。
- 平台不支持 `sandbox-exec` 或探测不过时不安装，绝不无沙箱运行。

代理：应用已配置的全局模型代理地址会作为 `HTTP_PROXY`、`HTTPS_PROXY` 传给安装进程，无账号密码。

### 上限

单次 20 分钟，输出日志 2 MiB。每工程保留最近 3 个缓存键，单工程 5 GiB，全部工程 20 GiB，超出时删最久未用的，运行中的不删。空闲空间不足时跳过安装并说明。工程设置提供「清除依赖缓存」。`ponytail:` 注释写明这些上限。产物遍历最多 200000 项、64 层，清理最多 250000 项、128 层；进程快照最多 131072 个本用户 PID，清扫扫描阶段最多 5 秒/200 个快照；四类固定准入探针 READY 最多等待 4 秒，每个受管进程最多 8 秒。安装运行中和副本克隆没有磁盘硬配额，空间预检和结束后大小检查不代表硬配额。

### 已知限制

- 用户于 2026-11-09 亲自使用生产沙箱配置测试了改名并 ad-hoc 签名的 launchctl 副本：创建任务被拒（退出 1、无 marker、未列出）；移除宿主自建任务被拒（退出 1，Not privileged to remove service，任务仍在）；系统 `/bin/launchctl` 执行被拒（退出 71）。宿主 trap 清理后两个自建标签均无残留。此结论限于这次生产配置与客户端实测，不能推广成全面的 IPC 隔离。
- launchd 读状态仍可，属于剩余风险；已发布的 Pi `run_command` 同样受影响。直接拒绝 Mach 消息陷阱会终止 Node，bootstrap 消息过滤配置在本机拒绝应用，已停止这条收口路线。
- 安装与 Pi `run_command` 共用策略，拒绝 `/bin/launchctl` 的 `file-read*` 和 `process-exec`，减少直接执行与复制客户端的入口；自带客户端、直接 IPC 等路径仍可能访问 launchd。这是减面，不是隔离，也不是启动前 IPC 准入证明。
- 主进程在每次实际安装、每次 Pi `run_command` 前后分别以宿主身份执行固定的 `launchctl list`，立即丢弃 PID/status，只比较标签集合。出现新增标签，安装不发布依赖；命令结果标为异常，本组后续命令停止。任务详情保存完整标签，通知提示检查“可能新增”的任务；标签不传入模型，也不自动移除宿主任务。读取列表失败同样停止命令、拒绝发布。
- `ponytail:` 标签差分只能事后发现：依据用户已实测生产沙箱内创建任务被拒的结果，忽略 GUI App 常规启动的 `application.*` 和 Spotlight 等系统活动自发新增的 `com.apple.*` 标签，以免频繁误报阻断依赖发布。攻击者也可借用这两个前缀绕过事后提示；该取舍不构成隔离，不能由标签前缀推断任务可信。其它宿主正常任务变动仍可能误报；前后快照之间出现又消失的任务、沿用已有标签或移除任务可能漏报，不能据此归因或宣称 launchd 已隔离。用户需自行检查实际标签。
- 不读 `~/.npmrc`，需要令牌的私有 registry 装不了。工程内不含密钥的 `.npmrc` 可用。需要时再加凭据方案。
- 依赖可以读到本工程源码和历史，且安装阶段有网络，恶意依赖能外传本工程代码。这和用户本地 `npm install` 风险相同，凭据层面更严。设置旁写明。
- 产物符号链接必须解析回根 `node_modules`；指向工作树其它目录的 workspace/file 链接会被拒绝，安装按退化路径继续。
- 依赖安装目前只支持 Node 工程，`custom` 仅用于自定义安装命令，也只搬运根 `node_modules`。Yarn PnP 与其它语言不支持；未产生该目录时如实退化，继续修改并说明原因。

## 任务对话

LR-I10。用户反馈：任务结束显示「需要补充」和代理说明后没有任何后续，是死路。从这一版起，每个任务详情就是一个和 worker 的多轮对话：用户可以追问、补充信息、要求修改，worker 回答或给出执行方案，方案只在用户点击「执行」后才运行。

### 对话视图

- 开头是系统生成的**任务摘要**（不存账本，每次按任务现状渲染）：各条意见的位置、原文、结论和理由，各组的状态、分支、提交、PR 链接、verification，任务的失败原因或汇总。之后是按序号排列的消息。
- 消息三种角色：`user`、`worker`、`system`。worker 消息、理由、summary、verification 均用现有 `renderMarkdown`（`renderer/components/pages/assistant/markdown.tsx`）渲染，不再挤成一段；系统消息用于回合失败/取消/中断和执行结果。
- 多行输入，⌘↩ 发送，Enter 换行。回合运行中输入框可继续编辑，但不能再发送；提供「取消本回合」。
- 每条意见、每个组有「在对话中引用」：在输入框光标处插入引用块（意见：`> 路径:起止行（side）` + 意见原文；组：`> 组 N「标题」` + 分支、短提交、PR 链接），同时把 `{ kind: "annotation" | "group", id }` 记入待发消息的 `references`。发送时主进程校验引用都属于本任务；提示词里按 id 重新取账本原文，不信任输入框里的引用文本。
- 任务标题改为「首条意见的 `路径:行` · 任务创建时间」，任务 UUID 放在次要位置（可复制）。
- 任务列表在有未读回复的任务上显示未读标记（见「未读」）。

### 账本与迁移

主进程内部账本（`ledger.json`）升为 `version: 2`，与 IPC 返回给渲染端的 `LocalReviewState` 版本分开（IPC 仍为 `version: 1`，同一构建内渲染端与主进程一起升级）。新增字段：

- `job.conversation`：`{ messages, nextSeq, readSeq }`。消息 `{ id, seq, role, createdAt, body, references, turnId, plan? }`，`seq` 单调递增，由主进程在写入串行化内分配。用户消息正文 ≤ 8000 字符，worker 回答 ≤ 16000 字符，系统消息 ≤ 16000 字符；账本保存原文，不保存裁剪结果。
- **消息数是软门槛**：任务消息数 ≥ 400 时，`sendMessage` 拒绝新的用户消息并提示新建任务；这是唯一的检查点。schema 不对 `messages` 设会被回执撞上的数量上限，worker 回答、系统消息、已认领执行和恢复产生的结果消息在门槛之后**照常落盘**。总量由来源有界保证：每个用户消息至多一个回合；回合重试最多 5 次、执行重试（含重试评论）最多 20 次，用完后按钮置灰；因此门槛之后新增的消息是有限的。`ponytail:` 注释写明 400、5、20。
- `job.turns`：讨论回合 `{ id, userMessageId, state: queued | running | answered | failed | cancelled | interrupted, attemptId, error }`。
- `job.executions`：执行记录（见「执行」）。
- 组新增 `origin: "evaluation" | "conversation"`、`requirements`（来自对话的要求原文，≤ 4000 字符，评估组为空）、`commits`（`[{ oid, executionId | null }]` 追加历史，首项为初次提交）。对话组的 `annotationIds` 允许为空，但 `annotationIds` 与 `requirements` 不能同时为空。
- **组数上限**：初次评估仍然 1–8 组（`reviewEvaluation` 的 `max(8)` 不变，只约束模型分组）；账本 `groups` 的 schema 上限放宽为 16，覆盖初次分组加对话新组的**累计**数。达到 16 组时，新组方案在校验阶段被拒绝（卡片显示不可执行及原因，提示新建任务），在写任何 intent 之前拒绝，不会写出第 17 组导致账本校验失败。`ponytail:` 注释写明 16。
- 主进程 `selectedGroupIds` 的 `max(8)` 同步放宽到 16。
- **版本与迁移（机器可执行的防降级）**：
  - 读到 `version: 1`：先把原文件原样复制为 `ledger.v1.bak.json`（已存在则不覆盖，复制失败则停止队列、不迁移），再在内存中显式迁移（对话为空、组 `origin: "evaluation"`、`commits` 由现有 `artifact.commitOid` 补首项），以 `version: 2` 原子写回。
  - 读到 `version: 2`：新增结构（消息、回合、方案、执行、组新字段）使用 `.strict()` schema，未知或非法字段使解析失败，不被悄悄剥掉后写回。
  - 读到其它版本或解析失败：沿用现有行为，保留原文件、停止队列、不写盘。
  - 旧版本 App 的 `ledgerSchema` 要求 `version: 1`，读到 v2 账本会走「无法读取，保留原文件并停止队列」，不会剥掉新字段再覆盖。

### 未读

- 消息**只追加、不原地改写**：执行结局变化、评论重试成功等都追加一条新的系统消息（新 `seq`），带 `executionId` 与 `attemptId`；旧消息保留为历史。对话按 `seq` 升序显示；方案卡片和组卡片显示该执行最新一条结果消息的状态。
- `readSeq` 是「用户已看到的最大消息序号」。渲染端在对话视图实际渲染出某条消息后，以该条的 `seq` 调用 `markRead({ jobId, seq })`；主进程取 `max(readSeq, min(seq, nextSeq - 1))`。不使用当前时间，也不一次标到「最新」：渲染之后才到达的回复仍是未读。
- 未读 = 存在 `role ≠ user` 且 `seq > readSeq` 的消息。系统生成的执行结果、失败消息同样计为未读。

### 两种回合

#### 讨论（默认）

用户发送消息即建立一个讨论回合，进入与任务相同的串行队列（`ponytail:` 仍是单队列，不与正在运行的任务并发）。worker 回答问题、解释判断、给方案，**不改文件、不推送、不开 PR**。只读不靠提示词，而是复用各 worker 评估阶段的同一套权限和沙箱：

| worker | 讨论回合的能力 |
| --- | --- |
| Codex 原生 | 与评估相同的 permission profile（`:workspace_roots = "read"`、网络关闭），同一个 argv 构造器，每次调用前同样跑快速金丝雀，探测失败关闭本回合 |
| Claude Code 原生 | 与评估相同的 settings：拒绝 Edit/Write 与 tree 写入，Git 元数据拒写，Bash 内置沙箱、网络全拒 |
| Pi | 只有评估的 list_files / search_code / read_file，没有写工具，也没有 `run_command` |

**读视图**：每个回合在 `<userData>/local-review/jobs/<jobId>/turn-<turnId>/` 建一个只读根，目录所有权清单与 probe/evaluation/group 相同：

- `base/`：任务固定提交 `headSha` 的检出。
- `group-<序号>/`：每个已有提交的组在其当前记录的 `commitOid` 上的检出。
- 都由主进程从受控 Git 对象检出（`--git-dir` 显式传入，清空环境，禁 filter/hook/fsmonitor），不读用户工作区。组对象来自该组保留的 `git/`（见「产物保留」）；不可用时该组视图缺省，并在上下文中写明「组 N 的提交本地不可用」，讨论回合不为此访问网络。
- 回合结束（任何结局）删除整个 `turn-<turnId>/`。

worker 的输出 schema（三种共用，宿主用 Zod 严格校验，缺失或非法只修正一次）：

```
{ reply: string(1..16000, Markdown),
  plan: null | {
    target: { kind: "existing", groupId } | { kind: "new", title(1..200) },
    annotationIds: string[],      // 本任务意见 id 的子集
    requirements: string(0..4000),// 对话中提出的、不在意见里的要求
    expectedChanges: string(1..4000),
    reason: string(1..4000)
  } }
```

一个回答最多一个方案。用户直接说「按这个改」时，worker 应给出方案，仍需用户点执行。方案在主进程校验：组属于本任务且状态为 `pr_opened` 或 `pushed_no_pr`，意见 id 都属于本任务，`annotationIds` 与 `requirements` 不能同时为空，新组不超过累计 16 组。校验不过的方案仍随回答保存，卡片显示「不可执行」及原因，不出现执行按钮。

#### 执行

方案只是数据，界面显示成卡片：目标（已有组 N / 新组）、涉及的意见与要求、预期改动、理由、「执行」按钮。**只有用户点「执行」才运行**，worker 回答或系统消息都不会触发执行。

点击「执行」调用 `execute({ jobId, messageId })`。主进程在账本写入串行化内原子完成：

1. 检查 `job.executions` 中没有 `messageId` 等于该方案消息的记录（方案消息本身只追加、不改写，认领状态只由执行记录表达；方案的校验结果和 `planBaseOid` 在回答落盘时一并写入该消息），任务不处于活动阶段（queued / evaluating / preparing_dependencies / running_groups），目标组没有进行中的执行；目标为已有组时，组当前 `commitOid` 必须等于方案生成时记录的 `planBaseOid`，否则方案过期，提示重新讨论。
2. 生成 `executionId`，写入执行记录 `{ id, messageId, turnId, target, planBaseOid, annotationIds, requirements, state: "pending", intent: null, attemptId }`。卡片据此显示「执行中 / 结果」。

同一方案再次点击（双击、多窗口、回包丢失后重点）已能找到同一 `messageId` 的执行记录，直接返回其 `executionId`，不会产生第二次执行。

执行状态：

```
pending → fixing → committed → pushing → commenting → done
            │          │          │          └→ done_comment_failed（推送已成功，只能重试评论）
            │          │          └→ remote_changed（远端已变，未覆盖，需要处理）
            │          └→ blocked（高风险或令牌扫描）
            └→ no_changes
活动阶段 → failed | cancelled | interrupted
```

**已有组追加**（目标组为 `pr_opened` 或 `pushed_no_pr`）：

1. 建私有副本：克隆用户仓库到组的固定 `headSha`，从组保留的 `git/` 取得 `commitOid` 对象；保留的对象不可用时，用受管网络入口 `fetch --no-tags` 拉取该分支到副本内的私有 ref，取到的 OID 必须**恰好等于**记录的 `commitOid`，否则直接 `remote_changed`，不调用模型。随后在 `commitOid` 上检出。
2. 依赖准备、修改（worker 修改阶段的同一套权限、沙箱、45 分钟上限、`run_command` 准入与 launchd 前后对比）、只提交声明文件、敏感扫描，全部沿用逐组修改的规则。提示词只给本方案的意见、`requirements`、预期改动和对话摘要。
3. 提交后两层快进检查：本地要求新提交的唯一父提交等于 `planBaseOid`，并且 `merge-base --is-ancestor <planBaseOid> <新提交>` 成立；然后 `ls-remote` 远端分支必须等于 `planBaseOid`（等于新提交表示上次推送已成功，直接记回执）。
4. 推送：`git push <url> <新提交>:refs/heads/<branch> --force-with-lease=refs/heads/<branch>:<planBaseOid>`，不带 `+`。lease 只负责远端比较交换（CAS），**不保证快进**（`--force-with-lease` 本身就能强推）；只快进由第 3 步宿主的唯一父提交与 `--is-ancestor` 两项实际断言保证，推送前两层都必须通过。远端被改过 → `remote_changed`，执行标需要处理，**不覆盖、不重试推送**，组的 `commitOid` 不变。
5. 推送回执落盘时同时把组的 `artifact.commitOid` 更新为新提交，`commits` 追加 `{ oid, executionId }`，组的变更清单与 diff 摘要改为相对 `headSha` 的累计结果，用于下一次风险检查与 PR 讨论。
6. 评论（仅 `pr_opened` 且有匹配连接）：用 `HostedPrClient.publishGeneralComment` 发一条说明，正文含本次追加的提交、涉及的意见与要求、每条 outcome/summary、`verification` 原话，以及一行可核对标识 `Paraself 执行 ID：<executionId>`。`sourceCommit` 用新提交，`destinationCommit` 从平台当前 PR 详情读取。正文按原样经 `HostedPrClient` 发布，**不改写 verification 原话**，也不去掉 4 字节字符；平台拒绝（例如 Bitbucket Server 对 4 字节字符返回 500）时记 `done_comment_failed`，保存将要发布的原文与平台错误，界面明确显示评论未发布并可复制原文，不说成成功。编码规范化如需要另行授权，不在本任务里做。PR 描述不更新（沿用「先出产物再开 PR」的取舍）。`pushed_no_pr` 组不评论，执行结果写明原因。

**新组**：校验通过后分配下一个序号、分支名 `paraself/review-<jobId>-<序号>`，`origin: "conversation"`，之后和普通组完全一样：准备副本 → 修改 → 提交 → 高风险与令牌扫描 → 推送（空 lease，只创建）→ 开 PR（PR 描述附 `requirements` 原文与对话中执行方案的预期改动）。任务状态从终态回到 `running_groups`，结束后重新汇总为 `finished`。

**沿用的关卡**：

- 高风险：命中即 `blocked`。授权绑定 `groupId`、**新的**提交 OID、命中清单、推送 URL，追加时还绑定 `planBaseOid`；任一变化授权失效。点「执行」不等于授权高风险，「仍然推送」仍需单独确认。
- 令牌扫描：命中后只能丢弃本次执行，「执行」「重试」「仍然推送」都不能绕过；被丢弃的追加不影响组原有的 PR 和 `commitOid`。
- 同一组的执行串行，与该组的重试、确认、丢弃共用互斥与 `attemptId`。
- 依赖准备、launchd 对比照常。

**结果回到对话**：执行的每个结局（done、done_comment_failed、no_changes、blocked、remote_changed、failed、cancelled、interrupted）都写一条系统消息：结局、新提交、分支、PR 链接、评论是否发布、verification 原话、失败原因，以及可用操作按钮（重试、仍然推送、丢弃、重试评论）。每次结局变化都追加新消息（见「未读」），因此已读后才发生的变化（例如重试评论成功）仍显示为未读；不会出现只在组卡片上可见的结果。

### 恢复

intent / receipt 规则沿用「恢复与重试」。执行补充：

| 阶段 | 重试或重启后做什么 |
| --- | --- |
| `fixing` | 与组相同：确认进程结束；有 commit intent 先从本次副本 Git 核对 OID |
| `pushing`（有 push intent，无回执） | `ls-remote`：等于新提交 → 记回执并更新组 `commitOid`；等于 `planBaseOid` → 用同一 lease 再推；其它 → `remote_changed`，不覆盖 |
| `commenting`（有 comment intent，无回执） | 先读 PR 讨论（`commentPages`）。标识按**完整行**匹配 `Paraself 执行 ID：<executionId>`，且同一评论中的提交行必须等于本次新提交，才算回执（引用旧标识的讨论不算）。只有分页**完整且全部成功**读完（`more === false`、无截断、无读取错误）仍没有匹配，才视为不存在并发布一次；分页被截断、读取失败或匹配存疑 → `done_comment_failed`，标需要处理，只提供「重试评论」，不盲发 |
| `done_comment_failed` | 只重试评论，按上一行先查后发 |
| `remote_changed`、`done`、`no_changes` | 不可重试；需要时在对话中重新讨论 |
| 任何已过 `committed` 的阶段 | 不再调用模型 |

讨论回合：重启时 `running` 的回合记 `interrupted` 并写系统消息；失败、取消、中断的回合都在对话里显示原因和「重试此回合」（以同一条用户消息重跑，新 `attemptId`，旧回调不能覆盖）。讨论没有外部副作用，重跑不需要核对。

取消任务时，进行中的讨论回合与执行一起取消；取消不回滚，已推送的追加保持原状。

### 产物保留

`pr_opened`、`pushed_no_pr` 组发布成功后改为只删 `tree/`，保留 `git/` 供讨论读视图和追加使用；过期仍为 14 天，但以该组最后一次执行或讨论读取的时间计。过期后讨论缺该组视图，追加改走受管 fetch。删除规则、所有权清单、realpath 校验不变。

### 上下文与裁剪

每轮把任务上下文和完整对话重新发给模型，三种 worker 都不依赖 CLI 自己的会话保存，Codex 仍用 `--ephemeral`，Claude 原生每轮新进程。

**整体预算**覆盖一次调用的全部初始输入：系统提示与方案 schema、任务摘要、读视图说明、引用原文、对话历史。预算按 worker 取值（`ponytail:` 注释写明）：

| worker | 初始输入预算 | 说明 |
| --- | --- | --- |
| Pi，非本地档案 | 60000 字符 | 现有上下文上限 100000，留 40000 给工具输出 |
| Pi，本地档案 | 11000 字符 | 现有上下文上限 19000，留 8000 给工具输出 |
| Codex、Claude 原生 | 60000 字符 | 与 Pi 非本地一致，工具输出由 CLI 自身管理 |

按优先级组装，前面的不被后面的挤掉：

1. 系统提示与 schema：固定，完整。
2. **最新用户消息正文：完整保留**（已 ≤ 8000），不截断。
3. 最新消息引用的意见与组：完整意见正文（≤ 4000）；`lineText` 与组 verification 超过 2000 字符时节选首尾，标「已节选，原文 n 字」。
4. 任务摘要：先用完整形式（意见正文、理由、组 verification）；放不下时逐级降为节选（意见正文、理由各 500 字，verification 各 500 字），再降为只列 `路径:行`、结论、组标题/状态/提交/PR，每级都在摘要开头标明「摘要已压缩，原文见账本」。
5. 读视图说明：固定，简短。
6. 对话历史：用剩余预算，从最近往前保留完整轮次，最多 12 轮；超长的历史 worker 回答节选首尾并标注；被省略的较早轮次替换为一行「已省略较早的 k 轮对话（共 n 轮）」。

第 1、2 项加上最小形式的第 3、4、5 项仍超出预算时，**在调用模型前**将回合记为 `failed`，系统消息写明「上下文超出所选档案的预算，未调用模型」并建议换用非本地档案或缩短消息，不静默截掉最新要求。每个回合在账本记录裁剪统计（摘要压缩级别、节选条数、省略轮数、实际字符数），系统消息不展示但详情可查。账本原文不受裁剪影响。

### 接口

| 位置 | 内容 |
| --- | --- |
| `packages/protocol/src/local-review.ts` | 消息、回合、方案、执行的 schema；组 `origin`、`requirements`、`commits`；`groups` 上限 16；IPC 输入 `sendMessage`、`execute`、`markRead`、`conversationAction`（取消回合、重试回合、重试/丢弃执行、重试评论） |
| `local-review-worker.ts` | `LocalReviewWorker.discuss(view, context, signal)`，共用讨论 schema、方案校验与提示词；`fix` 接受方案的意见与要求 |
| `local-review-agent.ts`、`local-review-claude-worker.ts`、`local-review-pi-worker.ts` | 讨论走各自评估阶段的只读配置 |
| `local-review-git.ts` | 读视图检出、受管 `fetch`、`--is-ancestor` 与父提交核对、带期望 OID 的 lease 推送 |
| `local-review-service.ts` | 回合队列、方案原子认领、执行状态机、恢复、评论 intent/receipt、上下文裁剪 |
| `renderer/components/pages/local-review/` | 对话视图、引用、方案卡片、未读标记、任务标题 |
| `renderer/preview-api.ts` | 预览实现 |

### 验收

- 单元：消息存取、序号与未读游标（渲染后到达的回复保持未读；已读后重试评论成功追加的新消息仍未读）；400 软门槛（第 400 条后拒绝用户消息，但已认领执行的 worker/系统结果仍能落盘，含恢复产生的消息）；账本迁移（v1 → v2 并留备份、备份失败不迁移、v2 新结构中的未知字段解析失败而非被剥掉、旧版 schema 读 v2 拒读不写盘）；整体上下文预算（50 条意见 + 16 组 verification 时摘要逐级压缩并标注、最新用户消息完整、引用节选、历史省略标记、Pi 本地档案放不下时调用前失败且未调用模型）；三种 worker 的讨论回合使用评估阶段的只读配置且确实不能写（Codex 金丝雀/假 CLI 写入失败、Claude settings 拒写、Pi 工具清单无写工具与 `run_command`）；读视图不含用户工作区；方案校验（未知组、未知意见、空意见与要求、第 17 组）；方案卡片不点不执行、双击只执行一次；追加只快进、远端已变时 `remote_changed` 不覆盖、推送回执丢失恢复、评论 intent 丢失先查后发、评论读取失败或分页截断不盲发、引用旧标识或提交不符的评论不算回执、平台拒绝含 4 字节字符的评论时如实失败且原文不变；新组执行开 PR；高风险授权绑定新提交、令牌扫描不可绕过；失败/取消/中断都产生系统消息。
- 组件：发送与 ⌘↩、引用插入、Markdown 渲染、方案卡片与执行按钮状态、未读标记、标题。
- `check:overflow` 明暗；全量 `volta run --node 22.22.2 env -u PARASELF_PROVIDER_CHILD -u DECISION_PROVIDER_CHILD npm run check -- -- --maxWorkers=4`。
- 实跑（隔离 App + 合成工程 + 本地假平台）：信息不足的意见 → `needs_input`；在对话中追问、补充 → 方案卡片 → 点执行 → 修好并开 PR；再要求对该组追加 → 同一分支快进、假平台收到评论；Pi + claude-code-cli sonnet 跑全程，Codex 跑一次讨论回合；用户仓库不变。
