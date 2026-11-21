# paraself-review / paraself-memory 实跑验收驱动：安全边界

文件：`scripts/lab/review-skills-lab.mjs`（纯函数：种子、检查、命令、事件判读）、`review-skills-guard.mjs`（MCP 守卫进程）、`review-skills-live.test.ts`（门控入口：无模型预检 `PARASELF_REVIEW_PREFLIGHT=1`，真实客户端 `PARASELF_LIVE_REVIEW_SKILLS=1`，默认都跳过）、`scripts/test/review-skills-lab.test.ts`（确定性自检，不起模型、不起 App）。`mcp-guard.mjs` 只加了 `export`，行为不变。

## 拆分与覆盖

| 环节 | 方式 | 覆盖 |
| --- | --- | --- |
| 安装/升级 | 候选包的真实 bridge CLI 安装，在**显式临时 home** 下运行（D9，由产品侧单独完成并留日志；本驱动不调用安装）；`isolated-app` 不重定向 HOME，所以启动 App 时 `base.HOME` 显式换成临时目录；安装出的副本与候选包 `Contents/Resources/skills` 逐文件核对 | 临时 home 内的安装、幂等、升级。**不等于**真实用户配置全覆盖 |
| 原生发现/加载 | 项目级副本：Claude `<taskRepo>/.claude/skills`，Codex `<taskRepo>/.agents/skills`（`taskRepo` ＝合成任务仓库根） | 原生机制。**用户级** `~/.claude/skills`、`~/.agents/skills` 的加载不测 |
| 检索行为 | 四个工具全部经守卫，事件流断言 skill→决策检索→普通笔记检索→笔记原文 | 受守卫的行为，合成 Vault |

不把全文注入 prompt 冒充安装验证。合成 canary（2026-11-17，Claude Code 2.1.325 / Codex 0.169）已证明两端的原生发现与加载路径。

## 不信任什么

模型、客户端、bridge 的输出、结果里的任何字符串。可信来源只有：冻结种子（文件、sha256）、从种子笔记解析出的字段、人工从源码摘取并标出处的固定措辞。**响应里的字符串不能给自己背书**：决策目录先经 `catalogFromSeed` 与种子笔记逐字段核对（id、来源目录、路径、hash、标题＝文件名、project、status、tags、summary＝`selected_option`、appliesWhen/caution、supersedes 与 supersededBy 双向、current），自由文字只信种子笔记原文和这些已核对字段。App 自己算出的关系、适用性、生命周期不由种子解析，按 App 输出接受并记为边界。

## 守卫（失败即关闭：写 `<root>/LEAK`，结束 bridge，退出 3）

- 启动：`--pin`（已审工具定义摘要）与 `--server-version`（当前包版本）必填，缺省不启动；`--record-digest` 只用于生成摘要供人工审，不服务客户端。`--seed` 是 root 下的冻结副本（含 HASHES.sha256），**每次启动重新 `verifyFrozen`**，种子和 `--task-repo` 必须在 root 下；守卫的种子不是 App 写入的 vault。11 个隔离路径在 root 下（`checkPaths`）。bridge 的 cwd 为 root，环境只有 `labProcessEnvironment` 白名单。
- `initialize`：协议版本在已知集合内，capabilities 只能是 `tools`，serverInfo 名为 `paraself` 且版本**严格等于**当前包版本（prerelease/其它 semver 一律拒），`instructions` 丢弃；回给客户端的是守卫重建的固定值。
- `tools/list`：只放出四个工具，摘要必须等于 pin。可信 pin 来自总控独立从已审源码构建的内存 MCP（`c627b621…d347`）；候选包的定义摘要与之相同，无需信任包内自述。
- 参数：只开四个工具；**未知键按各工具 schema 拒绝**（`ARG_KEYS`）；类型与范围按 schema（`limit`、`startLine`、`startColumn`、`maxLines`、`query` 长度）。`search_decision_context` 放开 skill 实际使用的全部 `source`（六个来源，单个或数组）与 `mode`、`minSimilarity`、`includeWithdrawn`——**不为守卫能力而削减被测能力**。`repositoryPath` 只能是合成任务仓库或其规范子目录（无 `..`、`.`、重复或结尾斜杠），不让 bridge 去解析用户真实 Git 路径。参数被拒写 `<root>/REFUSED`（客户端的失误或试探，不是结果泄漏），回固定说明，不结束本轮。
- 决策工具结果：`search_decision_context` 用扩展的严格 checker（`checkContextMessage`）：顶层/context/sources/record/sourceRef 每层键白名单，枚举与计数按 `decisionContextResponseSchema`；每个与查询无关的字段（含 signal、amendment、experience）必须与种子目录相等；摘录必须是笔记原文片段；matchReason/warnings/适用性理由只能由固定措辞和种子笔记解释；`similarity` 只在 `语义相近` 命中时允许；guidance 的每一行是 mcp-guard 钉住的句子或 `guidanceOk` 里手工从 decision-context-service.ts / decision-context-signals.ts 抄入的句子（带行号注释，数字只在源码放数字的位置）；正文 text 只能由已核对字段、固定句和种子笔记解释。没有种子的来源（preferences、ideas、experiences）允许空结果。`consult_decision_principles` 沿用 `mcp-guard.mjs` 的 checker（7af5e85c 后 consult 的渲染未变）。守卫收到的原始错误按 availability 枚举接受，转发给客户端的只有 `errorNotice` 固定说明；客户端实际看到的错误结果（证据复查）必须是短的固定说明、无记录。
- 笔记工具结果：`structuredContent` 必须恰为 `{message, search}` / `{message, read}`；内层按 `obsidian-notes.ts` 逐字段（类型与上下界先于种子绑定）：路径必须是种子里的普通笔记；title、contentHash 是**该笔记**的；snippet 必须是该笔记原文或其 Markdown 去标记后的纯文本（`plainText`，抄自 obsidian-search-service.ts:262-273）的连续片段；heading 是“父 > 子”组合路径，每一段都是该笔记里的标题且顺序一致；line 在笔记行数内；`message` 必须由 App 的固定句子（obsidian-note-tools.ts:19-26）拆解而成，且 `availability`、`semanticAvailable`、`isError` 与之一致；wrapper 的 `message` 必须**等于 bridge 对已核对内层字段的渲染**（`searchText`/`readText`，抄自 mcp-notes.ts），content 文本同样；`read`：startLine/startColumn 必须与请求一致（列夹到行长），未截断时正文恰为请求的行区间，**截断时**正文必须是余下笔记的真前缀，nextStartLine/nextStartColumn 是整数、在笔记内、且单调前进，提示句里的数字必须等于这些字段。不可用/拒绝时转发由已核对字段重建的句子，而不是一条无信息的通知。
- 协议信封：重复 id、批量数组、bridge 主动请求/通知、未问过的 id 的应答都拒绝或丢弃；单行 256 KiB；转发内容由已核对字段重建。

## 客户端限制

- 环境：`minimalClientEnvironment`（生产代码）+ `assertClientEnvironment`（白名单；任何含 KEY/SECRET/TOKEN/PASSWORD/CREDENTIAL/AUTH 的名字、`NODE_OPTIONS`、`SSH_AUTH_SOCK` 等都拒绝，只报变量名），`PARASELF_PROVIDER_CHILD=1`。
- 网络：只经 `ManagedChildProcessRunner({ modelNetworkPolicy: "required" })`；`MODEL_PROXY_URL` 在运行时由环境提供，不入库。不用 `context-run.mjs` 被阻断的 `runAgent`。
- 凭据：不读取、不复制任何 auth 文件；客户端用真实 HOME 登录。
- Claude：`--setting-sources project,local --tools Skill,Read,ToolSearch --permission-mode dontAsk`，`Read` 只对副本目录和任务目录放行，`--strict-mcp-config`。Codex：`--ignore-user-config`，内联 permission profile（`:minimal` 读；`/private/tmp`、`/private/var` 拒；`/opt/homebrew` 读〔codex 自身 fs helper 需要〕；仅授予副本与任务目录），保留 shell 以便原生读 SKILL.md（只去掉 `shell_tool` 的关闭项；`shell_snapshot` 与其余功能仍关闭）；Vault 目录不授予读权限。
- Shell 命令分类（`classifyCommand`）：一次工具调用最多 4 段，以 `;` 或 `&&` 连接，每一段独立判定，任一段越界则整条违规。允许的段：`cat`/`head -n`/`sed -n <N,Mp>`/`nl -ba`/`ls`（原 flag；无路径的 `ls` 列出工作目录，只列名字），路径（绝对，或相对 `cwd`）解析后必须在授权根内；`rg --files <授权根内路径>`（只列文件名）；`git status --short`；`git diff -- <授权根内路径>`。引号只取下，不做其它解释。违规：管道、重定向、展开、命令替换、换行分隔的命令、第 5 段起、其它程序或 flag、`..`、`=`/`:` 开头的魔法参数、能写/执行的 sed 脚本、双引号包裹时出现 `$`、反引号、反斜杠。`rg --files` 与 git 命令不计入“读过哪些文件”。调用方要把 `cwd` 传给 `parseRun`，否则相对路径与 git 一律违规。未知条目类型（file_change、web_search 等）一律违规。

## Codex 的 shell 环境说明（工具边界，不是任务提示）

Codex 的 shell 命令由 `classifyCommand` 逐段判定。真实运行里它的 review 习惯命令（git 加复合、`rg --files`、无路径 `ls`、换行分隔的多行）连续被误拒，逐形状补白名单不可持续，所以 `codexCommand` 以 `-c developer_instructions=…` 如实告诉 Codex 这个 shell 的边界（`codexShellNote()`）：单行、最多 4 段以 `;` 或 `&&` 连接；支持的命令形式（`cat`、`head -n`、`sed -n 'A,Bp'`、`nl -ba`、带原 flag 的 `ls`、`rg --files`、`git status --short`、`git diff -- <path>`）；路径须在本会话的文件读权限内（不点名任何目录）；不支持换行分隔、其它命令或 flag、管道、重定向、展开，且不可写。文字里没有产品名、技能名、工具名、检索主题、成功标准或答案，不要求读任何东西；冻结的用户 prompt 与文件 profile 不变。自检断言该配置存在、与常量一致、不含这些词。

记录方式：这是评估条件的一部分——Codex 的结果是“被告知了 shell 限制”的结果（总控离线用 `codex debug prompt-input -c developer_instructions=…` 验证过该键会进入 prompt）；Claude 的结果没有这段说明，矩阵里分开标注。解析器不再扩展。

## 合成任务仓库的前提（预检实测）

产品对 `repositoryPath` 要求真实 Git 仓库：不是仓库返回 `scope_unresolved`（错误）；是仓库但目录名与笔记里的 `project` 不一致，则决策被判范围不匹配（实测 `no_match`，`excludedByScope=2`）。因此合成任务仓库必须是：**目录名等于冻结场景的项目名（`orbit-queue`）、`git init`、可加本地 `origin` 指向 `https://example.invalid/…`（只本地配置、不联网；实测远端不改变项目名，项目名取自目录名）**，任务文件放在其下的 `task/`。在这样的仓库里按 skill 的正常方式（`repositoryPath`，不额外传 `project`）检索，实测 `matched`，现行决策（`current=true`）与被替代决策（`current=false, lifecycle=superseded`）都可达。这是验收 setup 的前提，不靠提示词绕开。

## runner 合同（live.test.ts ↔ 本目录，总控批准）

runner（`scripts/lab/review-skills-live.test.ts`，ps-skills-impl 维护）：
- R1 即时检查：给 runner 注入 `spawnProcess`，每个完整 stdout 行就 `parseRun`/`evidence` 判一次；同时看 `LEAK`、`GUARD_FAULT`、`REFUSED`（数据块与每 250 ms 轮询），出现即 `AbortController.abort()` 结束整个进程组。
- R2 一处出问题即整体停止：违规、标记、非 0 退出、超时或四个硬条件不全，都不再跑后续 case 与客户端；通过＝全部计划的 case 跑完且每个 `evidence.ok`（`coverage()`）。
- R3 运行前核对副本：runner 的 `verifyCopies` 要求两份项目级副本的逐文件指纹与被测候选包 `Resources/skills` 一致，并等于登记的最新版本指纹；runner 不调用 lab 的 `verifyInstalled`。
- R4 元数据快照只覆盖真实的技能目录与接入配置，不对会话日志整树比对。
- R5 App、records 连接、catalog 都在 try/finally 内。
- R6 凭据：不复制 auth，真实 HOME 登录；用户级技能的名字和描述会出现在客户端里，属于已接受的披露边界；**能读技能内容的只有任务副本**。
- R7 每轮前对 `<root>/seed` 调 `verifyFrozen`。
本目录（lab 模块）：
- L1 `guardArgs({root, bridge, client, seed, pin, version, taskRepo})`，守卫按上文核对种子与 root。
- L2 `catalogFromSeed(listed, seed)`：按种子笔记核对目录，返回 allowlist 条目。
- L3 Claude 分支把 `Skill` 调用与其 tool_result 配对；`skillLoaded` 要求结果成功，且（Claude）出现任务副本目录与副本正文首尾 200 字符（`skillMarkers`），（Codex）读取任务副本的命令 exit 0 且输出含这两段。init 事件列出的技能只记录（`ambientSkills`），加载任务副本以外的 Skill 才是违规。
- L4 `repositoryPath` 接受任务仓库及其规范子目录；参数被拒写 `REFUSED`，不写 `LEAK`。
- L5 `claudeCommand`/`codexCommand` 签名不变。

## 已知边界（不隐瞒）

1. Codex 保留 shell：读受限于 seatbelt profile，写只读、网络由 runner 的代理策略管；profile 内允许的读取仍是任意程序可读，仅限技能副本与任务目录。profile 语义依赖 Codex 0.169，版本变化要重做 canary。
2. 守卫的固定措辞来自人工摘取，漏掉的措辞会被拦（偏保守）；`guidanceOk` 与 `text` 的解释允许“固定句的任意组合”（沿用 decision-lab 记录的已接受边界），不证明语义真实。
3. App 自己算出的关系、适用性、生命周期、`current` 以外的字段，按 App 输出接受，不由种子解析。
4. 新工具的 bridge 渲染散文由 `searchText/readText` 的重建值精确比较；决策工具的散文由旧 checker 的“固定词＋已核对字段”复查。
5. 自检用构造的事件形状（含 Codex 的 `structured_content: null` 失败形状、Claude 的 `is_error`）；Claude 的 `Skill` 载入条件（任务副本目录加正文首尾标记）已被实跑的真实事件满足。
6. 用户级安装路径的原生加载不测。
7. 被测客户端是**正常启动的已登录客户端**，不是空白配置环境：它可能自动加载全局 `AGENTS.md`/`CLAUDE.md`，并在上下文里带用户级技能的名字和描述。这是评估的实际限制，不声称隔离了这些。驱动不主动读这些文件正文，不复制或链接任何凭据；工具仍只能读任务目录与任务副本技能，真实 App 和 Vault 的内容始终禁止（Claude 的 `Read` 路径限制、Codex 的 permission profile、MCP 只经守卫）。技能名只记录（`ambientSkills`），不因列出旧技能判违规；加载任务副本以外的 Skill 或读授权根以外的路径才是违规。全局指令文件可能影响模型行为，结论按“正常客户端环境下”理解。

## 最终证据（同一候选包与冻结场景，四格全部通过）

冻结场景：一条现行决策加被它替代的旧决策、一篇无属性头的普通总结笔记（关键约束在正文中段）、一条词面相近但无关的笔记、一条无关决策、一篇完全无关的笔记；待评审代码片段作为任务附件。工具定义 pin 为总控从已审源码独立构建的摘要。

| 格 | 客户端 / 实际模型 | 结果 |
| --- | --- | --- |
| claude 自然语言 | Claude Code 2.1.325 / `claude-sonnet-5-5` | 四硬条件全真，无 problem，退出码 0 |
| claude 显式 skill | 同上 | 同上 |
| codex 自然语言 | Codex 0.169.0 / `gpt-6.1-sol`（启动参数，Codex 事件流不回显 ID），带 shell 环境说明 | 同上 |
| codex 显式 skill | 同上，带 shell 环境说明 | 同上 |

每格的事件流都证明：原生载入了任务副本的 skill；对决策来源和普通笔记各自检索（无命中时换表述重试）；读了总结笔记原文。人工评分（四格一致）：现行决策（默认 120 秒、超过 40 秒每 40 秒心跳续约、续约失败放弃）被当作依据，被替代的旧决策（固定 30 秒）明确标为已被替代并指出代码正是旧做法，没有只凭日期选择；普通总结笔记的关键约束（死信先落盘并 fsync 再 ack；退避带随机抖动）被引用到具体行，并如实标为普通笔记、不是已采纳决策，适用性标 needs_review；无关笔记与无关决策没有被引用；答案如实披露本机嵌入模型缺失、只做了关键词检索，没有声称完整检索。

## 过程中的失败与修复（保留，不隐瞒）

- 第一轮（Claude 自然语言）：决策检索正确，但普通笔记检索只发一次英文查询、0 命中，没有换词重试，也就没读笔记。无语义补充时关键词检索对词面敏感。裁定：保留无本机模型环境（关键词降级是产品必须可用的正常状态），产品最小强化 skill（零命中拆成短词换表述）。
- 第二轮（强化后）：模型这次对笔记检索换了词并重试，但换的是项目名和“租约”，没有覆盖到每个主题（“死信”“重试”只用在了决策检索上），笔记检索仍 0 命中、未读笔记。产品再强化 skill（每个主题在决策和普通笔记两处分别查、零命中按主题按来源重试）；之后同一场景通过。
- Codex 的四类 harness 命令误拒：git 加复合命令、`rg --files`、无路径 `ls`、换行分隔的多行命令。这些是 Codex 的常规只读 review 习惯命令，不是产品失败；前三类以最小分支放行（每段独立判定，仍拒管道、重定向、展开、`=`/`:` 魔法、越界路径、其它程序），第四类改为不再扩展解析器，而是用 `developer_instructions` 如实告知 shell 边界。
- 审查中修掉的：目录绑定里 project/status 断言被行尾注释吞掉（自我背书）、Skill 载入证据可被事后 Read 满足、read 字段类型/续读、组合 heading、repositoryPath 范围、参数被拒与泄漏混用等，均有负例。

## Codex 的 shell 环境说明是评估条件

最终两格 Codex 带有 `developer_instructions`（见上一节）。它只描述 shell 工具边界，不点名目录、产品、技能、工具、检索主题、成功标准，不要求读任何东西；冻结的用户 prompt 与文件 profile 不变。所以 Codex 的结论是“被告知 shell 限制”条件下的结论；此前未带说明时 Codex 自然语言一格也曾通过（第五轮）。Claude 两格没有这段说明，不能与 Codex 两格当作同一条件比较。

## 限制

- 每格单样本，不是比例；模型、客户端版本、代理线路都会影响结果。
- 无本机嵌入模型（关键词降级）；有本机模型的环境未测。
- 被测客户端是正常启动的已登录客户端，使用真实 HOME 的登录；它可能自动加载全局 `AGENTS.md`/`CLAUDE.md` 与用户级技能的名字、描述，这些没有被隔离也没有被主动读取，不能说成空白配置。真实 App 与 Vault 的内容始终不可达。
- 技能是项目级副本（与候选包内置技能逐文件一致）；用户级安装路径的原生加载没测，安装/升级只在临时 home 里另行验证，不能宣传为覆盖真实用户配置。
- 守卫证明内容来源（种子、固定措辞、已核对字段），不证明语义真实；App 自己算出的关系、适用性、生命周期按 App 输出接受。
- 受限实验沙箱里 git 垫片/开发工具路径不可访问（`git diff` 失败，主环境的 git 正常），Codex 两格因此按整文件评审，没有验证真实 Git diff 的完整路径；这是实跑范围限制，不是产品问题。
- Claude 的 `Skill` 结果形状在首次实跑后按事件核对，载入条件（任务副本目录加正文首尾标记）已被真实事件满足。
