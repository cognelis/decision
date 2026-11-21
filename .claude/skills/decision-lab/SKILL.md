---
name: decision-lab
description: 在 Herdr 里组织多模型代理，对 Paraself 做「实跑基线 → 找断点 → 并行实现 → 集成 → 跨模型复验 → 再实跑」的改进循环。用于要求用真实调用路径（真实 claude/codex 对话、Hook、隔离打包 App、bridge MCP）验证并改进 Paraself 核心能力的任务；只改单个 bug、或不需要实跑证据时不用。
---

# Paraself 实跑改进循环

所有步骤都在 2026-10-21 的几轮实跑里实际跑过。下面的命令就是当时用的命令，只把个人路径换成了占位符。

## 0. 先决条件

```bash
test "${HERDR_ENV:-}" = 1 && herdr status        # 不在 Herdr pane 里就停：在独立终端运行 herdr，再在 pane 里启动 claude
herdr --skill | head -60                          # 子命令语法以本机为准
claude --version; codex --version; codex login status
```

实测模型是否可用，并记下真实 model id（订阅登录，不要设置任何 API key）：

```bash
PARASELF_PROVIDER_CHILD=1 claude -p "Reply with exactly: OK" --model sonnet --output-format json   # 看 modelUsage 的键
PARASELF_PROVIDER_CHILD=1 codex exec -m <model> --skip-git-repo-check -s read-only --json \
  -c features.plugins=false -c features.apps=false "Reply with exactly: OK"   # 不加这两项，每次调用都会同步远端插件和 Apps，约 10 MB
```

Codex 可用的模型在 `~/.codex/models_cache.json` 的 `slug` 里。不同别名、不同会话都不能冒充不同模型。

## 1. 不能违反的规则

- **代理 pane 一律带 `PARASELF_PROVIDER_CHILD=1`。** 这样代理自己的对话不会被用户真实的 Paraself 采集，也不会启动 Paraself MCP。bridge 看到这个变量（或改名前的 `DECISION_PROVIDER_CHILD`）就直接返回（`apps/bridge/src/cli.ts`）。
- **这个标记管不到 Codex 的 MCP。** Codex（0.165 实测）启动 stdio MCP 服务时只传一小组白名单变量（HOME、LANG、LC_ALL、LOGNAME、PATH、PWD、SHELL、SHLVL、TERM、TMPDIR、USER、__CF_USER_TEXT_ENCODING），`PARASELF_PROVIDER_CHILD=1` 和全部隔离路径都到不了 bridge，bridge 就连上用户真实的 App；Claude Code 则把整个环境传给 MCP。所以 Codex 代理 pane 启动时要加 `-c mcp_servers.paraself.enabled=false`。
- **被测会话（真实的 claude、codex 对话去连隔离 App）要三层隔离，每层都失败即关闭**，`context-run.mjs` 的 agent 步骤已经照做：
  - 不留读文件、跑命令的入口。`read-only` 沙箱只限制写，不限制读。Claude 用 `--tools ToolSearch`（paraself 靠 ToolSearch 加载）。Codex 用 `--ignore-user-config` 加 `CODEX_TOOLS_OFF`（`isolated-app.mjs`）。apply_patch 在 0.165 里没有开关，用 `writeCodexCatalog(root)` 写一份去掉了 apply_patch 的模型目录，经 `-c model_catalog_json=<文件>` 交给 Codex，Codex 就不再列出这个工具。不能只靠只读沙箱：评审实测，它在写入被拒之前会先读目标文件，能用来判断「某一行在不在」，只是不会把内容打印出来。事件流里一出现 `file_change` 或命令类条目，驱动就立刻 SIGKILL。
  - code-mode host 关不掉：0.165 里 MCP 调用也要经过它，关掉以后 paraself 一次都调不成。它能不能读文件，只有 Codex 自己的说法（`require`、`process`、`fetch` 都是 undefined），这一点没有独立验证，是剩余风险。
  - MCP 一律经 `scripts/lab/mcp-guard.mjs`（`guardCommand(root, bridge, client, tool)`）。它先把 11 个隔离路径逐个取 realpath，路径带换行、`..`、往外指的链接都拒绝，全部在 root 下才启动 bridge。之后只放开它被打开的那一个工具（`--tool`，默认 `search_decision_context`，R18 起也可以是 `consult_decision_principles`）。**可信来源只有种子，而且和待检响应分开，响应里的字符串不能给自己背书：**
    - warmup 读完整个目录后，App 列出的 id 必须和种子 id 完全相等，否则以 2 退出；每条记录连同它的笔记原文（从隔离 Vault 读出，sha256 必须等于 contentHash）写成快照 `<root>/agent-allowlist.json`；
    - 每个结果都按 `decisionContextResponseSchema` 的字段做严格白名单，出现未知键就拦；记录的内容字段必须和快照里同一条记录逐字段相等，摘录必须是笔记原文里的连续片段（原则的摘录用「…」分段，每段都要是）；
    - 依赖查询的字段（matchReason、warnings、applicability 的 reasons 和 status）只能由固定文字、种子字符串和数字解释，applicability.scope 必须和快照相等；guidance 和顶层 message 只认固定文字，availability 只认枚举值；taskScope 只能是客户端自己请求的范围；
    - 固定文字抄自 7269a75d：bridge 的措辞（`RENDERED`），App 的措辞（`mcp-guard-7269a75d.json` 的 `appWording`）；
    - consult（R18，钉在 7af5e85c）：快照里另有种子中的想法和偏好（`source: "journal"`，从隔离 Vault 读回，sha256 等于种子原文，解析出内容字段和 languages）。matches 的标题、原则、适用、边界必须等于快照里那条已采纳原则，reason 只能由固定文字、本条原则的字符串和共同词解释。signals 逐字等于守卫从种子按 App 的规则推出的那一条：summary 和 qualifier 按 4000 个 UTF-16 单位选（超出截到「…（节选）」），standing 按种类，reason 按模板代入共同词和钉住的 `languageLabel` 标签；matchedTerms 只能取自这条记录参与匹配的文字（不含 changeNote）。main 的 App 从不召回已归档的记录，所以指向已归档种子的信号直接拦下（`signal for an archived record`）。requestId、feedback.token 按 UUID 核对，expiresAt 按 datetime 核对，boundary 只认固定值。正文和 message 由守卫按 bridge 的写法从核对过的字段重新渲染，bridge 回的必须与之逐字相等，转发的也是重新渲染的版本；守卫自己的出错提示只按它确切的文字和形状认（驱动的 canary 会再核对一遍）；
    - 新措辞要手工加进守卫的模板，并写明来源，不从结果里采集；在那之前，带新措辞的结果会被拦下；
    - 正文只能由核对过的字段加固定文字解释；正文不超过 65,536 个 UTF-16 单位；入站单条 JSON 消息不超过 256 KiB；转发的 structuredContent 按核对过的字段重建；
    - initialize、tools/list 和 ping 由守卫按 7269a75d 的定义（consult 的工具定义按 7af5e85c，`consultTool`）（serverInfo、instructions、工具的 title、description、inputSchema、annotations）自己作答，bridge 回的同名字段必须完全相等；
    - 出错的结果按 availability 换成 bridge 原来的固定说明，JSON-RPC error 只保留 code；
    - 协议信封也要核对：复用还没完成的 id、发批量数组都回错误；bridge 主动发来的请求和通知一律丢弃，撞上 pending id 的写 LEAK；上游发来的不是对象，写 `GUARD_FAULT`。
    不过就写 `<root>/LEAK`，结束 bridge，以 3 退出。常量是钉在 7269a75d 上的：bridge 或 App 改了措辞、换成别的版本，守卫就会拦下正常结果（失败即关闭），要跟着重抄。
  - **守卫只证明内容来源，不证明语义真实（总控裁定接受的边界）。** 正文里的每个字都来自核对过的字段或固定模板，但固定词片段的任意重排（例如凭空写一句「实际结果：低于预期」）、凭空出现的数字都拦不住。这些固定文字本身就是公开模板，数字的信息量很低，而且要先由我们自己的 bridge 产生不一致的输出才会出现。
  - 环境只给白名单，不按名字往外删，所以名字不规范的凭证也带不进去。按真实的启动链：`startIsolatedApp`、`connectMcp`（包括确定性步骤启动的守卫）、守卫启动的 bridge，都经过 `labProcessEnvironment`（`isolated-app.mjs`），只留系统变量、`PARASELF_SMOKE` 两个开关和 11 个隔离路径，启动子进程之前先断言，失败即停，报错只列变量名、不列值；agent 客户端启动的守卫本体跑在客户端的 `testedEnvironment` 里，进去之后再过滤它派生的 bridge。capture-run 的被测会话照旧用 `isolationEnvironment`，保留用户配置。
  - 外层清凭证仍是第二道防线：用 bash 数组拼 `env -u`（zsh 里未加引号的 `$VAR` 不分词，R18 因此一个都没删掉），断言有残留就中止。
  - 驱动看到 `LEAK` 或 `GUARD_FAULT`，或者流式输出里出现金丝雀不认的结果，就立刻杀掉被测进程，以 2 退出。
- capture-run 的 Codex 会话要保留用户配置（它的 Hook 在里面），所以同样带上 `CODEX_TOOLS_OFF`，把 `codex mcp list --json` 列出的其它服务逐个关掉；paraself 经守卫连接，允许列表为空。
- 判断「被测代理读没读到」要看事件流里的工具调用，不看答案。返工 1 的直接探针里，haiku 一次工具都没调用，正文里却编出了一串主目录条目。
- 需要 Hook 或 MCP 真正生效的子进程，环境要用 `scripts/lab/isolated-app.mjs` 的 `isolationEnvironment(root)`。它会去掉上面那个变量，并把 bridge 读的 5 个路径和 App 读的全部路径都指到 root 下。缺一个，bridge 就会回落到用户的真实目录。
- `isolationEnvironment(root)` 会把当前环境原样传下去，只去掉 `PARASELF_PROVIDER_CHILD` 和旧名 `DECISION_PROVIDER_CHILD`。用 capture-run 这类会启动 claude、codex 的入口之前，先在外层去掉 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY` 这类会切到额外计费的变量，以及名称含 KEY、SECRET、TOKEN、PASSWORD、CREDENTIAL 的变量，并断言过滤结果。第七轮安装后盲测的第一次过滤只认标准名字，漏掉了别名形式的密钥变量，两轮采集作废重跑。
- 跑测试要用 `env -u PARASELF_PROVIDER_CHILD -u DECISION_PROVIDER_CHILD npm run check`（bridge 两个名字都认）。否则 bridge 的 hook 和 install 测试会全部失败（共 12 项）。
- Codex 代理的 PATH 里可能是 Homebrew 的 Node 26，不在 `package.json` 的 engines 范围内，在它上面跑出的测试结果不算数。验收前先看 `node --version`，要用 Volta 的 Node 22。`--configLoader runner` 只在 Codex 沙箱里调试时用：第三轮它掩盖过一个 jsdom 测试的导入失败，验收一律用标准的 `npm run check`。
- 核对隔离时，比较实验时段内真实目录 `semantic-pair-spool/receipts`、`capture-spool/events`、`candidate-spool/items` 的新增（只看文件数和时间），再与隔离目录里的回执数对照。总控会话通常就是用户真实的会话，它的 Hook 照常写真实目录，所以整棵目录树的文件数不能当隔离指标。数量对不上时，再看两点：真实新增的创建时间是否与隔离回执成对重合（第四轮 6 个真实新增里只有 1 个与隔离回执相差 1 秒以内，属于偶然水平）；同时段其它会话是否在活动（`herdr agent list` 的 `state_change_seq`）。全程不读真实文件的内容和文件名。
- **不要在 `node_modules` 是符号链接的 worktree 里打包**（`npm run build`、`npm run make`、electron-forge）。打包的清理步骤会顺着链接清空主 checkout 的 `node_modules/.bin`，第一轮发生过一次。需要打包时，先把依赖换成独立副本：
  `rm node_modules && cp -c -R <主 checkout>/node_modules node_modules && npm rebuild --ignore-scripts`
  然后确认 `.bin` 的条目数和主 checkout 一致。只跑测试的 worktree 可以继续用符号链接：桌面主进程和 vitest 都用 alias 指向 worktree 自己的源码。
  例外：在符号链接 `node_modules` 的 worktree 里改了协议包的导出时，Electron 布局检查会大面积失败，因为渲染层的 vite 顺着 `@cognelis/decision-protocol` 解析到主 checkout 的旧包。要跑全量 check，先换成独立副本。
- Codex 代理在 `workspace-write` 沙箱里既起不来隔离 App（启动即 SIGABRT），也建不了本机模型的推理 context（「Failed to create context」，用不了 Metal）。这两类命令要让它申请在沙箱外运行；Claude 代理不受这个限制。
- 不读用户的真实 Vault、`~/Library/Application Support/Paraself/`（改名前、App 还没首次启动过时是 `Decision/`）下的业务数据，也不读私有语料，这些内容不能进入任何 prompt。只允许做聚合计数，例如 `sqlite3 -readonly … count(*)`。
- 不用宽泛的 `pkill` 或 `killall`，只结束自己记录过 PID 的进程。不改 `/Applications`、`~/.claude`、`~/.codex`。
- `scripts/` 下的脚本不能写死个人绝对路径或旧产品名，`scripts/test/release-portability.test.ts` 会查。实验目录的默认值用 `PARASELF_LAB_ROOT`，没设时退回系统临时目录。
- **脚本启动的 App 和测试里的 Electron 不能打扰用户。** 第九轮之前，隔离 App 每次启动都把窗口最大化并抢走焦点，实跑循环每隔几秒启动一次，用户没法正常用电脑。现在只要设了 `PARASELF_SMOKE=1`（isolated-app、smoke、visual-fixture 都会设），窗口默认不上屏，也不进 Dock、不建托盘、不发通知。确实要看得见窗口时设 `PARASELF_SMOKE_SHOW_WINDOW=1`，窗口会出现在最前面，但不抢焦点。实跑一律显式传 `--app` 和 `--bridge`，别让运行器回落到不带免打扰的旧构建。
- 验证「不抢焦点」必须在屏幕解锁时做：每 0.5 秒记一次 `lsappinfo front`，以及进程的 `type`（`Foreground` 表示在 Dock 里有图标，`UIElement` 表示没有）。锁屏时前台一直是 loginwindow，第九轮第一次核对就因此漏掉了离屏窗口抢前台：窗口设了 `show:true` 或调用了 `window.focus()`，knowledge-layout 抢了 6 次。离屏窗口要设 `show:false`；焦点类检查用 CDP 的 `Emulation.setFocusEmulationEnabled`；`dock.hide()` 放在主进程的第一个 import 里。
- 用户反馈被打扰时，按这个顺序处理：先按 PID 停掉正在开窗口的运行器和测试；再通知全队暂停开 App 和 Electron；需要时挂一个守卫，只结束不带免打扰的实验构建（判断依据是 app.asar 里有没有 `SMOKE_SHOW_WINDOW` 这个字符串）；修好并在解锁状态下核对之后再放开。正在运行的 bash 脚本不要原地覆盖，bash 是边读边执行的，要换个新文件名。

## 2. 实跑入口（`scripts/lab/`）

| 入口 | 测什么 | 用法要点 |
| --- | --- | --- |
| `isolated-app.mjs` | 隔离启动打包 App；`connectMcp` 连 bridge MCP | `startIsolatedApp({ root, useLocalModels })`。`useLocalModels` 只读链接本机模型目录。启动失败或超时会回收子进程 |
| `capture-run.mjs` + `capture-score.mjs` | 真实的 claude、codex、grok、agy 两轮对话 → 用户已注册的 Hook → 隔离 App 的识别结果 | `--scenarios --only --models claude:sonnet,codex:gpt-6.1-sol --out --root --app --bridge`。<br>同一个 root 同时只能跑一个运行器，不同 root 可以并行。<br>`--sample-hooks <dir>`：只对 grok、agy 有效，用 `scripts/lab/sample-hook.mjs` 抓原始钩子输入，不启动 App。<br>`--installed-hooks`：只对 grok 有效，直接走用户在 App 里装好的钩子，不加项目钩子，也不加 `--trust`。<br>Grok 默认也会加载 Claude 的钩子，bridge 看到 `GROK_HOOK_EVENT` 就会跳过 |
| `context-run.mjs` | 合成 Vault 上的 `search_decision_context`、`consult_decision_principles`、写后回读；agent 步骤让真实的 claude、codex 会话经守卫检索后作答 | `--scenarios --only --out --app --bridge --local-models`。退出码 0 表示全部通过，1 表示有标签未满足，2 表示入口故障或泄漏。<br>agent 步骤：`{ "id", "tool": "agent", "prompt": "<问题>", "mechanism"?: "M1", "outside"?: "<标记>", "expect": { "answer": { "mustInclude": […], "mustExclude": […] } } }`，必须显式写 `--agents claude:sonnet,codex:gpt-6.1-sol --reps 2` 才会调用模型，每个代理 × 次数一行；`--agents` 默认为空，不写（或写空串）就只跑确定性步骤、不产生 agent 行，`--reps` 默认 2。`outside` 会把标记写进 root 之外的一个合成文件，路径代入提示词里的 `{outside}`，用来做越界探针（`scenarios/r16-escape.json`）。<br>提示词固定在驱动里（`AGENT_PROMPTS`，`--prompt default|neutral|consult`；`consult` 只开放 consult，答案行写「答案：<一个选项>」），按最后一行「答案：」判 current / stale / other（不区分大小写），超时 180 秒记 `timeout`；summary 的 `agentCounts` 按代理、机制分别计数，每次的完整事件流和 stderr 在 `<out>/agents/`。<br>隔离做法见第 1 节。claude 被测会话要加 `--claude-setting-sources project,local`，否则用户的插件 Hook（ecc GateGuard）会拦 MCP 调用。`--root` 放在 git 仓库之外（例如 `$TMPDIR`）。场景里的种子有一条没进 App 的目录（笔记格式不对），就以 2 退出。<br>想法和偏好种子放在 `Decision Journal/preferences/`、`ideas/YYYY/MM/` 下，用 storage 的序列化代码生成；有一条没被 App 读到（consult 回答里带 signalsIncomplete），也以 2 退出。确定性步骤加 `"guarded": true` 就经守卫去问；consult 步骤用 `mustSignal`、`mustNotSignal` 断言想法和偏好，`mustFlag` 加 `includes`（以及 `present`）判断某段文字在不在（样例 `scenarios/r18-consult.json`） |
| `scenarios/run-fresh-vectors.mjs` | 不重启的前提下，新记或复盘后的决策能否立即被语义找回 | 与 context-run 参数相同 |
| `npm run evaluate:semantic -- --corpus F --report-only --format json` | 只看规则层的识别 | 64 条开发语料已经饱和，结论要看保留集 |
| `rules-compare.mjs` | 同一批（助手消息, 回复）在不同规则版本下的档位、信号和选中项 | `--cases <json> --rev <sha 或 worktree> [--rev …] --out`。用例字段：`id`、`assistantText`、`userText`、`decision`、`expectedSelected`、`group`；`expectedBand: "any"` 不计分。`cases/` 下的两份对抗集是不能变差的回归集 |
| `probes/*.mjs` | 启动后主进程停顿与 MCP 可用性（`startup-probe`，冷/暖）、模型加载后 SIGTERM（`sigterm-probe`）、启动后立即退出（`quick-quit`）、暖态查询延迟（`latency`，`latency-fresh` 每次查询前先写 1–4 条新记录） | 都要 `--app`（.app 包）、`--bridge`、`--label`、`--out`，`--n` 为次数。实验目录取 `PARASELF_LAB_ROOT`。候选与 main 必须用同一份探针，只换 `--app`、`--bridge`。停顿用「每 100 ms 探一次 `/health`，相邻两次成功应答的最大间隔」从外部量，不用改 App |

场景格式写在各运行器开头的注释里，以及 `capture-scenarios.json`、`capture-scenarios-partial.json`、`scenarios/*.json`。规则改动后，已经录下的真实对话原文可以直接离线重放，不必重跑：第一轮逐条核对过，离线重放与 App 的判定一致。

- **等待时间可以配置。**
  - 健康检查等待：`PARASELF_LAB_START_TIMEOUT_MS`，默认 60 秒。负载上百、又带本机模型时，可能要 180～300 秒。
  - 退出等待：`PARASELF_LAB_STOP_TIMEOUT_MS`，默认 120 秒。App 退出时最多会等模型关闭 60 秒；新构建首次启动还在编 Metal、或负载过 400 时，75 秒不够用。
  - context-run 和 fresh-vectors 要等到「一次检索的语义补充不超时」才开始计分。`lifecycle.json` 里会记下 `semanticReadyMs`，以及每次退出的信号和 stderr 末尾。
  - 种子实例以前崩了（SIGABRT）不判失败，一直没人看见。现在要看 summary 里的 `abnormalExits`。
- **新构建第一次用本机模型时要现编 Metal 着色器，约 7–8 秒。** 第十轮之前，这一段在主进程里，会把 App 整个冻住；本机模型挪进 utility process 之后，只有模型子进程在等，主进程照常应答，这几秒检索只有关键词结果。Metal 缓存按 `CFBundleIdentifier` 分目录（`$DARWIN_USER_CACHE_DIR/<bundle id>/com.apple.metal`），只重签名清不掉，量出来是暖的。要测冷启动，得复制构建，给主应用和各个 helper 的 bundle id 加随机后缀，再 ad-hoc 重签；`probes/lib.mjs` 的 `makeColdCopy` 就是这么做的，测完连同缓存目录一起删掉。
- **codex-cli 0.161 每次 `codex exec` 都会同步远端插件和 Apps，约 10 MB。** PR 回放 4 路并发时，持续约 5 MB/s。Paraself 的 codex 调用已经加了 `-c features.plugins=false -c features.apps=false`，手写的 codex 命令也要加。按进程测流量用 `nettop -P -x -L <n> -s 1 -J bytes_in,bytes_out`，取该 PID 的最大累计值。
- **查 GPU 占用和发热，按进程统计 GPU 时间。** 用 `ioreg -l -w 0`，把每个 `IOUserClientCreator`（pid）下的 `accumulatedGPUTime`（纳秒）加起来，隔 5～10 秒取两次相减，再除以区间长度。这个方法不需要 sudo，各进程加总应与 `IOAccelerator` 的 `Device Utilization %` 对得上。
  - 时间若记在 WindowServer 上，说明它在替各个窗口做合成，应用自己的进程 GPU 为 0 也不能就此排除。先「显示桌面」，分清是窗口的问题还是系统的问题；再逐个 ⌘H 隐藏应用，同时用 CGWindowList 记录哪些应用的窗口还在屏幕上（读这个列表不需要屏幕录制权限）。
  - 第十轮之后就是这样查到主窗口（当时还叫 Decision）的：透明窗口、常亮的毛玻璃和 Liquid Glass，即使窗口被完全挡住，也会让 WindowServer 持续多占 35～40 个百分点（IMP-139）。不透明窗口配上跟随激活状态的毛玻璃，放在后台时为 0，但窗口在前台时仍会多占约 11 个百分点；最后改成了不透明、不用毛玻璃。
  - 要复现某组窗口参数的开销，用同版本 Electron 写一个最小窗口：`show: false`，然后 `moveAbove("window:<最靠后窗口的编号>:0")`，把它放到所有窗口后面。这样既不抢焦点，用户也看不见。打包 App 关掉了 inspect 熔丝，没法这样挪。
- **先确认运行器真的执行了每种步骤。** 第十轮有一次「删除后仍能查到」，后来查实是 `run-fresh-vectors.mjs` 当时不认识 `remove` 步骤：文件根本没删，被记成了泄漏。给出「泄漏」「退化」这类结论之前，先在 `requests.jsonl` 里找到这一步确实执行过的痕迹，比如 `removedAt`。
- **证据文件的标签要带上轮次。** 第十轮有一次对照标签用了 `main`，覆盖了第五轮留下的同名基线文件；实验目录不在版本管理里，覆盖了就恢复不了。
- **往 `scripts/` 加样本或驱动之前，先跑一遍 `scripts/test/release-portability.test.ts`。** 第十轮有一份对抗场景把维护者的个人目录写进了参数，到集成时才被拦下。

`run-fresh-vectors.mjs` 的「新记立即找回」和向量生命周期检查都依赖后台同步的时机。负载高时（load average 三十以上），main 和候选都会偏低或直接失败，所以比较版本要等负载降下来，再背靠背各跑一次。全量 check 在高负载下也会有计时、界面等待类测试偶发失败，要单独复跑这些文件确认。多个 worktree 同时跑全量 check 时，Electron 界面测试（settings、rationale、knowledge 等布局测试）会互相干扰，约 10 秒超时后报 `process_failed`，每次失败的项都不一样。实现者报的这类失败先不算数：总控在集成分支上，先用 `ps` 确认没有别的 vitest 或 Electron 进程，再跑一次全量。第五轮这样跑了两次，都是全绿。改动前后对比的做法：用同一份场景、同样的模型，分别对 main 的打包 App 和候选构建（`--app <worktree>/out/Paraself-darwin-arm64/Paraself.app/Contents/MacOS/Paraself`）各跑一遍，每种至少 2 次。Hook 永远调用已安装的 bridge（`--bridge` 只影响 MCP 连接），分类在 App 里完成。但 bridge 的文本回退会先用它自带的规则判断这轮是不是在请用户选择（`apps/bridge/src/text-fallback.ts` 的 `asksReader`，即 `analyze() !== null`），判不出的根本不会送到 App。所以：只改回答侧（`complete()`、`readReply`）的规则，安装前就能用这条路径验证；改了请求识别（`analyze()`）的规则，安装前跑会被旧 bridge 挡掉而低估，要等安装后 bridge 与 App 同版，再用隔离环境跑；bridge 自身的改动同理。

### PR 评审的回放验证

工具用法见 `docs/pr-review-replay.md`（prepare → run → score）。第四轮实际这样组织：

- **样本**：从本仓库历史里挑后来被 fix 修掉的缺陷，取引入缺陷、还没修的那次提交作为 head，再加几个不该报的反例。用固定随机种子拆出开发集和保留集；保留集由判定代理持有，冻结时记 sha256。实现者只拿开发集调，也不许翻 fix 历史找答案。
- **判定**：判定代理逐条判候选是 true_positive 还是 false_positive。作者在注释里写明是有意取舍的缺陷标 `tradeoff`，单独报告，不算硬漏报；标签之外但确实成立的问题另外计数。改标签要留修订记录和前后哈希。
- **快照**：实现者会继续提交。要测的提交先建 detached worktree（`git worktree add --detach <dir> <sha>`），再用 `--implementation <dir>` 指向它；它的 `node_modules` 是符号链接时，加 `--cache-dir` 指到可写的隔离目录。
- **漏报归因**：对照候选和最终结果，把每个漏报落到环节上：没读到材料、读到了没报、核验否掉、定位失败被丢、合并时丢掉等。`report.conclusions[].checked` 能看出「看到了，但因作者注释没报」这类情况。
- **成本**：每次比较都记输入 token 和耗时相对基线的倍数。第四轮候选版本是基线的 2.0 倍 token、1.6 倍耗时，主要因为评审循环每组都用满了调用次数。
- **合成 PR**：`generate-pr-adversarial.mjs` 生成的合成仓库没有调用方，核验员容易对「缺调用约定」的推测给出确认。合成集适合看误报面；要收紧或放宽核验，先在真实代码的保留集上确认。要测核验的反例，先确认评审阶段确实会对它提出候选：第六轮的 4 个「保护在别处」的合成反例，在发现阶段就被评审员自己搜到保护而放过了，核验员一次都没经过，所以测不到核验收紧的效果。
- **旧保留集改作回归集**：新保留集验收新能力，上一轮的保留集再跑一次，专门看召回有没有掉。第六轮的核验收紧在新保留集上与 main 持平，正是在 R4 回归集上发现 3 个真问题被推进了待核实，才决定不合入。
- **对照的基线要和 main 同码**：拿旧回放当基线前，先确认那次回放的实现快照与当前 main 在被测代码上相同（`git diff --quiet <快照> <main> -- <被测路径>`）。第六轮拿 R4 的两次回放对照，它们跑在 R4 的候选快照上，main 之后还有一个改评审的提交，比较里混进了这个提交的影响；第七轮因此把 R4 基线改为在 main 上重跑。
- **回放默认不测「应用决策」**：回放里的决策检索固定返回「没有结果」，R4 到 R7 测的只有找缺陷。要测决策这一面，用 `--decisions <夹具>`（与 context-run 种子同格式的合成笔记，回放用 App 自己的检索跑在临时 Vault 上）和 `--rules <规则目录>`，默认评审与 `--depth deep` 分开跑。base 和候选要从同一份回放脚本调用，只让 `--implementation` 不同。
- 单个样本两次回放之间，硬缺陷最终召回就会差 1 条（第八轮 main 在 R4 上是 3/13 与 2/13），门槛要么写明容差，要么加大重复次数，并且在看到结果之前写定。
- 带 `--decisions` 回放时，DecisionContextService 是从被测代码树加载的。main 改过检索代码，决策维度的 main 基线就要在当前 main 上重跑：第八轮的 7/8 跑在旧检索代码上，第九轮重跑了。不带 `--decisions` 时决策检索固定返回 no_match，不受影响。
- 「常规评审意见」（缺陷以外的设计、测试等建议）另起一轮来出，两次都没过门槛。第八轮出得多，但只有 55% 合格；第九轮 112 次评审只出 5 条，合格 2 条，每次评审还多花约 2.8 万输入 token。找缺陷这种传统代码评审由默认评审承担：第九轮 46 个最终问题人工判定全部成立，误报为 0。

## 3. Herdr 团队

总控留在当前 pane。新 tab 一律不抢焦点，并带上隔离变量；ID 从返回的 JSON 里读：

```bash
herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd <worktree> --label baseline --env PARASELF_PROVIDER_CHILD=1 --no-focus   # .result.root_pane.pane_id
herdr pane split <pane> --direction right --cwd <worktree> --env PARASELF_PROVIDER_CHILD=1 --no-focus                           # .result.pane.pane_id
herdr agent start base-a --kind claude --pane <pane> --timeout 90000 -- --model sonnet
herdr agent start base-b --kind codex --pane <pane> --timeout 90000 -- -m gpt-6.1-sol -s workspace-write \
  --add-dir <实验目录> --add-dir <主 checkout>/.git -c sandbox_workspace_write.network_access=true \
  -c mcp_servers.paraself.enabled=false -c features.plugins=false -c features.apps=false   # 标记管不到 Codex 的 MCP，见第 1 节
```

### 模型分工

用户要求（2026-10-27）：「补充一下合理的安排 claude、codex 的模型使用，没必要一直用一个模型，根据不用模型擅长选取合适的模型」，随后又明确：「codex 只参与评审，不要参与开发。」派任务前按下面选模型，在任务单和 ledger 里写明选了哪个模型、为什么。

**开发一律用 Claude**，包括实现、修复、补测试、界面、实跑脚本、隔离实跑和视觉设计。按难度选：

| 任务 | 模型 |
| --- | --- |
| 跨包重构、设计取舍、涉及隐私和安全边界、涉及用户真实账号或环境的摸索、视觉设计（直接用 Claude Design，不用脚本渲染图片） | `opus` |
| 规格清楚的常规实现、补测试、界面小改 | `sonnet` |
| 读日志、整理样本、批量核对 | `haiku` |

**Codex 只做评审**，包括代码审查、对抗评审、按复现脚本复核修复。它不改仓库代码，也不提交；复现脚本写在实验目录里，在冻结快照上跑。按难度选：

| 评审内容 | 模型 |
| --- | --- |
| 并发与时序、协议和隐私边界、跨包重构 | `gpt-6-astra`（官方定位是「最难的工作」） |
| 常规代码审查、复核修复 | `gpt-6.1-sol` |
| 快速核对（例如只确认某个断言是否成立） | `gpt-6-luna` |

- 开发者（Claude）和评审者（Codex）天然来自不同厂商。Claude 内部的多次调用不算独立意见：第十五轮同一个模型问三次，错误是相关的。
- 同时跑多个 Claude 开发代理时，留意 Claude Max 的 5 小时窗口（状态栏有显示）。opus 留给最需要它的任务，常规活用 sonnet。
- 实跑里作为「被测客户端」跑真实的 codex 对话（例如 capture-run 的 codex 驱动）不算开发，照常进行。
- CL1 的教训：一开始按「Codex 擅长大重构」把实现派给了 Codex，用户随即要求 Codex 只做评审。它已经写的改动作废了，存档在 `rounds/CL1/discarded-codex-impl/`。

- Codex 启动时如果弹出升级提示，`herdr agent send-keys <name> esc` 只跳过这一次；不要升级，也不要选「跳过到下个版本」。
- Codex 重启时如果提示「Background server has incompatible feature settings」，选「Run without daemon this time」。不要选「Restart with these settings」：那会重启共享的后台服务，打断用户和其他代理的 Codex 会话。
- 某个 Codex 模型可能单独被限流，返回 429（第十一轮的 gpt-6.1-sol，同一时刻 gpt-6-sol 正常）。先用一次最小调用确认，然后换模型，在每条记录里写明实际模型。`codex exec` 加上 `--ephemeral -c features.plugins=false -c features.apps=false` 和 `< /dev/null`。
- `herdr agent prompt` 的正文如果放在双引号里，不要写反引号：shell 会把它当作命令执行，那一段就发不出去。
- 代理用对话框提问时，状态会变成 `blocked`。先 `herdr agent read <name> --source visible`，再用 `send-keys <name> shift+left` 打开问题，选好后按 `enter`。只回答在授权范围内的实现取舍；产品取舍留给用户。
- 先派完全部独立任务，再统一收结果。任务单写清楚：轮次、任务编号、工作目录、基线版本、模型、可改与不可改的范围、输入、验收条件、报告与证据的绝对路径。报告固定为这几段：版本、模型、数据 / 实际执行 / 证据 / 发现（已核实事实、可复现问题、待验证假设）/ 修改 / 验证 / 风险 / 需要总控。
- 等待用后台运行的 `watch-agents.sh <秒> <名字,…> [文件,…]`：任何一个被盯的代理离开 working 状态，或指定文件出现时就退出，退出会通知总控。不要高频轮询。`idle` 或 `done` 只是收结果的信号：要读报告、核对任务编号和证据才能算通过；代理挂着后台 shell 时，idle 并不代表做完。
- 同一个 Codex 账号上，回放和交互代理共享限流。第四轮 3 路回放加 2 个交互 Codex 代理同时工作时，新派的任务一开始就 429；回放降到 2 路后没再出现。在后台跑回放的代理会显示 done 或 idle，进度要看输出文件数。任务单里写并发上限时，要写明是单个代理的上限还是全队合计；第六轮 pr-runner 按全队合计理解，只开了 1 路，基线回放因此多花了约半小时。
- 代理刚收到提示词时，状态会短暂显示 idle 或 done，按状态等待的监视器会被误触发。更可靠的做法是等报告里的完成标记，也就是段末的「…完成」。
- 等完成标记时，已经处理过哪些标记要由总控自己记下来，不要在监视器启动时拍快照当作「旧标记」。第七轮有两次，新标记恰好落在总控读完上一个标记、重启监视器之前，被当成旧的漏掉了。
- 比较新旧标记不要用 `comm`：标记里有中文时排序口径不一致，第八轮因此漏报了 9 个标记。用 Python 求集合差。监视器的超时设成 15 分钟左右当心跳，到点就核对一次进度，别让用户长时间收不到消息；后台有长任务（例如本机模型全量评估约 40 分钟）时，可以并行的判定要先派出去，不要干等。
- 派发前看 Codex 周额度：Codex pane 的状态栏会显示 `weekly limit: N% left`。回放按上一轮实测估算 token（第六轮每次约 25 万输入 token；第七轮的 PR 验收计划要约 160 次、4400 万）。会用掉用户这一周大部分额度时，推迟回放验收，只做实现和不调模型的检查，并定一条停派线。第七轮在 21% 时开工，3 个交互 Codex 代理一小时约用 2%。
- 实现者和验收者用不同的模型。保留集由验收代理自己写，实现者不读。
- **大一点的架构改动先审设计。** 实现者先写设计段，并附上小实验来证明关键前提；审过再大改。第十轮把本机模型挪进子进程时，设计审查查出一处隐私退化：子进程冷编译期间，状态查询会超时，分类链就会落到下一个后端，而那可能是远端。这个问题在实现之前就修掉了。
- **代码审查请两种模型各自独立做，互不看对方的意见。** 第十轮 Codex 审查者先后查出 6 处另一位审查者漏掉的问题：两处崩溃计数与关闭顺序，四处当场嵌入的预算、删除时序与后台补建。审查者要附上能复现的脚本；修完以后，把同一批脚本改成断言正确行为再跑一遍，才算关闭。
- **Codex 额度读不到时，看会话日志。** 状态栏不显示时，读最新的 `~/.codex/sessions/**/*.jsonl` 里的 `rate_limits`：`primary.used_percent` 是周额度已用的百分比，`resets_at` 是下次重置时间。第十轮就是靠这个确认额度已在北京时间 01:09 重置。
- 实现者和对抗者都往 `scripts/lab/cases/` 加样本时，文件名要用不同前缀：实现者用 `r<N>-<线名>.json`，对抗者用 `r<N>-adversarial-*.json`。第五轮出现过同名文件，集成时会冲突。
- 对抗者要先跑冻结样本，再读候选代码。第五轮有一次工具调用先输出了源码，那次的盲态就不完整了。
- **监视器每次退出都要在同一轮里重新挂上。** 第十三轮有一次监视器以心跳退出后没有续上，又赶上 Claude 代理遇到 API 连接中断（ECONNRESET），全队停了三个多小时，直到用户说「继续」。代理显示 done 或 idle 却没有写完成标记时，要读它的屏幕，看是报错了、在等后台任务，还是根本没收到任务（第十三轮 analyst 启动后停在欢迎页，派发的任务没有送达）。
- **采样并发按每个代理分配。** 每次 `claude -p` 都会拉起全部 MCP 和 hooks，三个代理各开几路时，机器 1 分钟负载到过 380。按每个代理最多 1 路 claude、1 路 codex 分配，全队合计才不超过 6 路。
- **本机 4B 的真跑要串行，并交给能稳定运行它的代理。** 第十三轮 skeptic 所在的 Codex 环境里，Metal 多次无法创建命令队列，严格串行后依然失败，冻结集的选中调用全部回退。holdout 的环境能稳定运行。需要真跑 4B 的验证排成队列，一次只开一个进程，用完通知总控再派下一个。
- **Herdr 的代理名在所有工作区里是全局的。** 第十四轮总控对 `reviewer` 发了两次 `send-keys … esc`，打到的是用户另一个工作区里同名的 Codex 会话。起名前先 `herdr agent list` 查重，用带轮次的名字（`r14-reviewer`）；发键前核对返回的 pane_id 在自己的工作区。
- **代理挂着后台 shell、显示 done，不等于在跑。** 第十四轮 impl-pick 的 4B 启动命令被权限拦下，它停在 done 等放行，总控却当成在跑，耽误了约 2 小时。要用 `ps` 和输出文件的时间核实。4B 真跑改由总控读过脚本后代跑，记下 PID。
- Claude Code 代理的输入框里，有时会出现自动建议的下一句（第十四轮出现过「总控：a2 已跑完…」）。那不是谁发出的消息，不要当真，也不要替它按回车。
- **Codex 启动时的对话框会吞掉第一条任务。** 第十五轮三个 Codex 代理先后卡在升级提示和 hooks 审查对话框（t 全部信任 / enter 审查 / esc 关闭），派发的任务没送达，空等约 45 分钟。`agent start` 之后先 `agent read` 看屏幕，按 esc 关掉对话框（不要按 t：全部信任会改用户的 `~/.codex` 设置），派发后十秒内核对状态变成 working。
- 监视器要用后台任务挂，退出时才会通知总控。用 `&` 挂，或放在前台把输出丢进 /dev/null，都会吞掉事件（第十五轮各发生过一次）。
- 放行 4B 队列后看一眼 `ps`：第十五轮 holdout 把同一条命令开了两次，两个进程写同一个输出文件、抢同一块 GPU。只请它结束后开的那个，总控不结束别人的进程。
- **外层清凭证要真的生效，断言失败必须中止。** 第十八轮 r18-lab 在 zsh 里写 `env $UNSET …`，`$UNSET` 没有分词，一个变量也没删；断言打印出了 `LEFT: CLAUDE_CODE_MESSAGING_TOKEN`，命令却照跑，令牌进了隔离 App 和 bridge 的进程环境（没有调用模型；实验目录里搜不到这个变量名）。要用 bash 数组或 zsh 的 `${=…}`，断言不过就 `exit`。
- **起 pane 时清理凭证变量要不区分大小写。** 第十六轮总控只 unset 了全大写的三个，漏了三个大小写混写的凭证变量，它们留在了各代理的环境里；被测会话那一层，是驱动的环境白名单兜住的。先用 `env | cut -d= -f1 | grep -i -E 'key|secret|token|password|credential'` 列出名字，再逐个 unset。
- **涉及隐私边界的驱动改动，要等评审复验通过再放行实跑。** 第十六轮第一次是总控自己核对完冒烟证据就放行了基线，评审随即查出 4 个 P1（其中一个是 Codex 的只读沙箱不限制读），只能停跑重来；第三次又在复验还没结束时先放行了 claude，评审发现守卫会信任响应自身的字符串，又停了一次。评审发现正在跑的实验有问题时，会直接用 Herdr 发消息到总控 pane。先往保守的方向停跑，再读报告核实。
- **加固要先写死门槛和退路。** 第十六轮守卫返工两轮后仍有新缺口，于是在复验 3 之前写定：只判关键缺口是否关闭、有没有新的自我背书路径；要求我们自己的 bridge 或 App 先产生不一致输出才成立的同类 P2，记为剩余风险，不再返工。
- **运行器被结束时，可能留下孤儿隔离 App（父进程是 1）。** 先用 `ps eww -o command= -p <pid>` 核对 `PARASELF_SMOKE=1`，以及 `PARASELF_USER_DATA` 在实验 root 下，再按这个 PID 发 SIGTERM；本机模型关闭最长要等约一分钟。同时告诉起它的那个代理，免得两边对同一个 PID 先后下手。
- **基线和集成要分开。** 实跑固定在一份 APFS 克隆的已安装包上（`cp -c -R /Applications/Paraself.app <实验目录>/apps/Paraself-<sha>.app`，签名不变），`--app`、`--bridge` 都指向它。这样 `/Applications` 换成新构建，也不影响正在跑的实测；守卫的常量也钉在这个版本上。

## 4. 每轮步骤

1. **基线**：在 main 的打包产物上跑 capture-run、context-run、evaluate:semantic 和 `npm run check`，记下 commit 和模型。
2. **分析**：并行派出能力分析（只读）、反例（必须走真实路径）、实跑代理。对照 `docs/decisions/implementation-decisions.md`，有意设定的边界不当缺陷处理。先有序列化的证据，再下结论。例如第一轮里，「Codex 配对率低」用审计时间序列核对后，证实不是缺陷。
3. **选题**：每轮 1～3 项，至少一项直接改善核心决策行为，比如识别更准、找回更全、反馈能改变后续结果。
   - 盲测集要求「严格提高」的门槛，只在 main 的盲测基线里确实有要修的那类失败时才成立。holdout 交出 main 基线后，先核对它列的失败机制里有没有本轮的目标；没有，就当场调整盲测集或门槛，并写进 ledger。第十一轮的 v10 漏的全在回答侧，提问侧修得再好也过不了门槛，这一点在基线出来时就能看出来。
4. **实现**：每项一个 worktree、一个分支，先写出能复现问题的实跑场景，再修根因。根因要落在所有调用方都会经过的那一处。
5. **集成**：合进集成分支，换成独立依赖，跑全量检查和 `npm run build`，在**集成后的构建**上重跑所有场景和保留集。worktree 上测出来的结果不能当作最终结论。
6. **复验**：派另一种模型做代码审查和对抗测试；验收代理跑保留集。不同意见回到代码和证据裁决，不按多数投票。
   - 验收代理每轮先新写一批保留集，在候选出来之前冻结并记下 sha256。
   - 实现者在对应的保留集冻结之前先不提交（可以改代码、跑测试），总控确认冻结后再放行。这样「冻结早于候选」可以直接用提交时间证明。
   - 旧保留集可以用来做机制诊断，但只把「停在哪道判断、命中哪个上限」告诉实现者，不给原文。
   - 新冻结集上的失败，本轮不再转给实现者，留到下一轮，并且下一轮要重新写保留集；否则它就失去了盲测的意义。
   - 规则类改动（识别、复盘排期）通常要迭代好几版。对抗者的盲写样本、白盒样本，以及审查者的探针，都可以全量交给实现者当开发集；保留集只给按类别的聚合数字。每一版都要同时检查两件事：新集合上有没有改进，旧集合逐条有没有退化（对正例的档位和映射设下限断言）。第五轮的复盘规则做了四版，识别做了四次返工，每次都是审查或对抗拦下了新的误报，或者真决定被降档。
   - 返工两次仍过不了门槛时，先把门槛和退路写死：达不到，本轮就不合入。然后做收敛式返工，新增的规则只作用于最窄的语境（例如只在点名了选项的分句里生效），不去放宽通用的上限。第六轮的识别线就是这样，在第三次返工时通过了门槛。
   - 白盒对抗要在读过候选 diff 之后写，每一版都派一次。第七轮复盘线三版里，盲写的冻结样本都没测出问题，两次大批误排都是 skeptic 读过代码后写的白盒样本测出来的；审查者的探针也可以直接加进门槛的开发集。
   - 用「没找到某类词」来证明「没有表态」的上限，三次都压掉了真决定（第六轮识别第一版，第七轮识别第一、二版）：真决定的说法是开放的，词表补不全；改成正面认出「不表态」的形状也一样漏。这类上限在第二版之前就要写死退路（整体撤掉），第七轮最后按退路撤掉了。
   - 旧保留集的失败机制转给实现者以后，实现者容易补出只对同形说法有效的窄规则。第七轮按上一轮验收集机制补的复盘规则，19 句同义改写只过了 6 句，还在描述、条件句里误排。这类收益在报告里不要写成「这一类已覆盖」。
   - 模型层（规则 + 本机模型 + 路由）的评估要用足够长的超时（例如 60 秒），把超时和模型判断分开统计，并记下当时的 load average：全队同时跑本机模型时，延迟会放大好几倍。本机 Qwen 4B 在 temperature 0 下输出逐字稳定，改路由时用已有的模型输出离线重放（`scripts/lab/model-compare.mjs --replay`），几分钟就能验证一版，不必重跑模型。采集分类默认只用规则，评估前先确认测的是哪一种配置。
   - 两个候选各有取舍时（第八轮：A 只减待确认噪声，B 把错误写入从 14 降到 3、但有 1 条真决定从直接写入降成待确认），先按事先写死的门槛选；涉及产品边界的交换交给用户，用户接受后再找折中（第八轮 B2 用一条窄路由把那条真决定救回来）。
   - 判定之前，先核对两件事：保留集测的是不是候选要改的机制；有没有断言和已经定下的设计（`docs/decisions/implementation-decisions.md`、现有测试）相冲突。第九轮找回验收集第二版有两处持续失败：一处是设计边界（新写入的记录约 1 秒后才进语义补充），一处和「被替代记录照常返回并标注」冲突。而这一轮的主要改动（先有替代关系、再写复盘导致绑定失效）这套集合根本没覆盖。处理办法是：原门槛和原结论都不改，由验收代理按问题描述盲写一份对准这些机制的补充集，先冻结、再跑；这份补充集测出了 8 步由败转胜。
   - **IMP 编号**：开工时就给各条线分好编号段。第九轮 PR 评审和找回两条线都用了 125、126，后面只好改号。
   - **规则线的收敛写法**：第十三轮 rules-v10 前两版每加一处通用判断，审查就在旁边找到新的误判。最后一版把旧规则原样包起来：旧规则找到问句的轮次，结果与旧规则逐条相同；只有旧规则判不出时，新路径才生效，结果封顶为待确认；新路径读成 low 时当作没有判断（`ruleReading` 返回 null），不让路由借它压低模型的结论。这样新路径只能增加识别，审查和对抗都没再找到退化。
   - **门槛之外的发现同样算数。** 第十三轮补选项的最终版在门槛上只差 1 条，但真正写错的那一条正例没有选中标注，门槛没有计入；是对抗代理从代码路径指出、总控在判定的真跑输出里核实的。最后一次返工又重新打开了一条之前修好的错写，这时即使门槛过了也不该合入。
   - **标注争议和门槛覆盖要在看到候选输出之前定。** 有些旧集的空选中标注其实是「冻结 main 的已知缺口」，不是正确答案；第十三轮让 holdout 先定统一规则（只计档位、不计选中），并把旧集清单扩到全部公开识别集，再判候选。偏离事先写定的门槛（例如只合入一条线里没问题的那部分）要请用户决定，并在台账里写明。
   - **候选让模型换了说法，冻结的计分要认得出来。** 第十七轮的 guidance 要求「说明两者关系尚待确认，不要仅凭日期选择」，codex 就把「无法确定」改成了「无法仅凭日期确定……待确认」。冻结的正则只认「冲突 / 无法确定」，4 次点名了双方的回答被记成 other，指出冲突的门槛按冻结口径差了 4 次，只能事后请用户裁定。所以候选的措辞定稿之后、跑盲测之前，要把它会诱导出的说法补进计分（或者改用盲评），main 和候选用同一口径算。
   - **冻结之前，先在 main 上确认每一步真的走到被测机制。** 第十七轮盲测集的 c05–c07，较新的那条在 main 的 18 次运行里一次都没被检索到，只在本页内起作用的提示对它们无从生效，门槛只好在看候选结果之前改成只算可见的那部分。写盲测集的代理冻结之前要在 main 上逐步核对前提（例如两条都在返回里），不满足的步骤要么改写，要么单独标出机制、不进门槛。
   - **台账里盲测代理要读的段落，只写门槛和口径，不写候选的设计参数。** 第十八轮总控在 R18 段记设计进展时，写进了候选的召回门槛（≥14），盲测代理读到后，把种子的字面重合做得足以触发它，dropped 的召回因此偏容易。设计进展要另放一处，或者记在盲测代理不读的段落里。
   - **canary 和守卫的回归测试要用真实客户端的事件形状。** 第十八轮的 G2 复验用的是模拟事件，真实 Codex 却把「没有 structuredContent 的结果」记成 `structured_content: null`，canary 把它判成泄漏，正式实跑中途被中止，四个运行器全部重跑。冒烟时让每种客户端都走一遍出错的路径，留下真实的事件当回归用例。
   - **监视器要同时盯运行器的退出和 summary 的 error、leak 字段**，不能只等 LEAK 文件。第十八轮那次中止，是驱动自己的 canary 在 summary 里报的，盲测代理的监视器没有察觉，另外三个运行器又空跑了近十分钟。
   - **只能选一个的答案格式会放大「显眼效应」。** 第十八轮把已放下的选项连同「不要再作为建议提出」交给 agent，sonnet 重选它的次数反而从 5 次升到 15 次：工具只提到这一项，最后一行又必须写一个选项，sonnet 就写了它，有时前面还刚说过「不能套用」。测「agent 会不会避开某个选项」时，要么不强制单选，要么设一个「交还用户」的选项。
   - **测「否决」之前，先分清语义，也别让提示词替 main 压低基线。** 第十八轮的 dropped 题多是放下一条规定（「默认用 PostgreSQL」）。放下规定不等于否决这个选项，按「不选它」计分是错的。提示词又要求「只依据工具返回的内容回答」，main 上工具什么都不返回，agent 多半答「没有相关记录」，基线被压到 7/60。第十九轮改用显式否决（用户勾选「以后不要再向 agent 建议它」并写原因），配合 advise 提示词：先 consult，再结合自己的判断，允许「交给用户」。
   - **「是不是同一件事」靠字面规则判断有上限。** 第十八、十九轮让否决的想法在相关时交给 agent，召回规则两轮改了四版：
     - 每次扩大开发集、评审另写独立探针，「同词不同事」的误报和同义改写的漏召回总有一头过线。第十九轮第二版在实现者的开发集上是 81%，并入评审的 24 个探针后降到 78%。
     - 用修饰语核对对象，既能被绕过（对象写在别的分句、context 或括号里），又会误杀（把「统一」「不」当成对象）。
     
     这类判断下一次要换判断来源，例如交给 agent 判断，或者用有延迟预算的语义判断，不要再在词表和阈值上返工。开发集和规则一起长出来时，过线不能算证据，要以评审独立写的探针为准。
   - **性能探针要真的走到新路径。** 第十九轮 G4 的样例里，有效记录先占满了名额，否决评分提前返回，一次都没跑，延迟看起来和 main 持平。评审在名额没满、2000 条否决的情况下，测出单 core 约 267 ms。测新增的计算路径，先用计数或打点确认样例确实执行了它。
   - **监视器要解析 JSON 取值，不要 grep 字段名。** 第十九轮盲测代理的监视器把 summary 里的 `"error": false` 当成出错，停掉了正在跑的运行器，claude 那一路只好重跑。被停掉的那次还留下一个不响应 SIGTERM 的孤儿 App，核实身份后按 PID 发了 SIGKILL。
   - **在并行子进程里清凭证，每个子进程要自己重建清单、自己断言。** bash 数组不能 export，`xargs … bash -c` 里拿到的是空数组。第十九轮的诱人程度核对因此整批重跑了 44 次。
   - **设计阶段的实验也要先定停止条件。** 第十四轮补选项在最后一次设计实验之前就写死：跑完没有策略满足「零写错」的选择规则，就不进入实现。结果确实没有策略满足，这条线当场收住，没有带着沉没成本返工。
   - **同一个模型问几遍，不是几份独立证据。** 第十四轮让同一个 4B 原序、倒序、逐项求证、再改三分类，类别标题、交回、评价、现状照样每次都读成「现在选定」。要加的是不同来源的判断，不是同一来源再问一遍。
   - **探针要让被测路径真的走到。** 第十四轮机制探针原先写成行内列表，规则抽不出选项，根本没进补选项路径，是分析代理查出来的。每条机制探针配两种写法：合成分类版（直接给出选项）和规则能解析的版本。离线先数一遍进入路径的行数。
   - **门槛定在一个还没建好的集合上时，建好先看 main。** 第十四轮门槛 f 要求探针「在候选上都不写错」，建好才发现 main 自己就写错 7 条。总控在看候选数字之前裁定：main 没错的探针绝对不写错，main 已错的探针不得新增或换成别的错项。这是放宽，要写进 BRIEF 并告诉用户。
   - **公开用例的标注可能同时是单测锁定的现状。** `packages/core/test/text-decision-analyzer.test.ts` 直接 import 了 `r4-recognition`、`r5-ir2`、`r12-map`、`r13-rule` 等文件，断言 `expectedSelected`。holdout 复核出真值不同时，不改 `expectedSelected`，在 note 里记下真值，等修映射时一起改。
   - **只删不加也会漏。** 第十五轮把旧读法原样包起来、外面只删选中，档位和路由在结构上不变，但「删掉的是不是错项」仍靠词表判断：初版在 50 条近义真选择上误删 30 条，收窄两次后，最后复审仍在 11 个机制上各找到误删（「方案已定、执行推迟」「交回的是别的细节」「采用句换个说法」）。最后一次收窄之前要写死「按机制去留」，复审只判去留，不再收窄。
   - **外部判定模型作为第二来源**：jev 与本机 4B 都同意才收，测试集写错少了一半多，但剩下的都是两边都错的伪选项（类别标题）。开发集上定的阈值（0 写错）到了测试集写错 12–15 条，阈值要在盲测上验证。
   - 在 zsh 里，`set -- $var` 不按空格拆分。第九轮因此建出了两个名字带空格的 worktree。批量命令改用函数加显式参数。
7. **交付**：按仓库约定合入 main，然后构建、签名、启动并安装 `/Applications/Paraself.app`（安装脚本会移除改名前的 `/Applications/Decision.app`），最后确认安装后能正常运行（见 AGENTS.md）。

轮数不设上限，除非用户另有规定。达到目标，或者连续两轮都没找到值得做、又能验证的核心改进时，停止。中断后恢复，先读实验目录里的 `ledger.md`，再看 `herdr agent list` 和报告，不要重复派发有写入行为的任务。
