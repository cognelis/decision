# 构建与本机安装

- 本项目改动验证通过并合并回 `main` 后，默认继续构建、验证签名与启动、安装本机 `/Applications/Paraself.app`（`scripts/install-local-macos.py --apply` 会同时移除改名前的 `/Applications/Decision.app`），并确认安装后运行正常，无需用户再次提出要求或确认。
- 用户当次明确要求不构建、不替换或暂停时，遵循当次要求。
- 仅修改文档或备忘时，不必单独构建和替换 App；用户明确要求时仍执行。

# 仓库与同步

- 远端：`origin` 是 Gitee，`github` 是日常用的私有仓库，`github-public` 是保留的公开仓库 `cognelis/decision`。地址用 `git remote -v` 查看；私有仓库的地址不写进仓库文件，公开同步会把它带出去。
- 公开仓库与私有仓库没有共同历史：它的每次更新都是私有仓库 `main` 的整份快照。不直接推它的 `main`，定期用 PR 同步并合并：

  ```bash
  git fetch github-public
  snapshot=$(git commit-tree 'main^{tree}' -p github-public/main -m "sync: 同步私有仓库 main@$(git rev-parse --short main)")
  git push github-public "$snapshot:refs/heads/sync/$(date +%F)"
  gh pr create --repo cognelis/decision --base main --head "sync/$(date +%F)" --title "sync: …" --body "…"
  gh pr merge --repo cognelis/decision --merge --delete-branch <PR 编号>
  ```

- 同步前确认要公开的内容里没有本机绝对路径、私有仓库地址或凭据；合并 PR 不触发发版，发版只由推送 `v*` 标签触发。

# 文档

- README 只写概览：是什么、怎么安装和接入、数据放在哪。英文 `README.md` 与中文 `README.zh-CN.md` 内容保持一致，改一份就同步改另一份。功能细节不写进 README，写进 `docs/iteration-roadmap.md` 对应的迭代条目或专题文档。

# 实跑验证与改进循环

- 每轮 RSI 开始先全局盘点采集、检索、反馈复盘、知识与待办、本地执行、接入和可靠性，再按用户影响、现有证据、可验证收益及成本重新排序。上一轮的未完项不自动成为下一轮最高优先级。
- 将本轮候选、选中理由、暂缓理由和验收条件写入 `docs/rsi-improvement-ledger.md`，选择当前最高价值的 1–3 项推进；全局盘点不等于每轮都改所有模块。用户当次明确指定重点时遵循当次要求。
- 需要用真实调用路径验证或改进核心能力（采集识别、历史找回、反馈闭环）时，按 `.claude/skills/decision-lab/SKILL.md` 执行：隔离实跑入口在 `scripts/lab/`，多模型团队用 Herdr 组织。
- 硬性规则：实跑一律使用 `scripts/lab/isolated-app.mjs` 的隔离环境，不碰用户的真实 Paraself 数据（改名前的 `Decision` 目录同样不碰）；不要在 `node_modules` 是符号链接的 worktree 里打包；跑测试前去掉 `PARASELF_PROVIDER_CHILD` 和旧名 `DECISION_PROVIDER_CHILD`。

# 界面改动顺序

- 界面功能先在设计稿上画出并经用户看过，再实现，这是强制顺序（用户 2026-11-10 要求）。Paraself 的所有设计都放在同一份设计稿里，不同功能用页面（page）区分（用户 2026-11-11 要求）：https://claude.ai/artifact/CsaWzJMXPFhNHPNEGJuw23 。画之前先截 App 现有界面，按钮、字号、间距沿用 renderer 的 styles.css 变量。纯 bug 修复不需要先出图。

# MCP 工具

- 提供或改动功能时，同步设计并实现这项功能完备的 MCP 工具：用户在界面上能做的事，agent 经 `paraself` MCP 也能做，受同样的确认和权限约束；读和写都要有。例外在功能方案里写明理由，例如批准、合并 PR 不提供工具，因为 AI 的批准不算人。已有功能缺工具的，改到它时一并补上（用户 2026-11-18 要求）。
- 工具命名遵循 `docs/decisions/naming.md` 的“MCP 工具命名”；新增或改动工具时，同一版本里更新 `skills/` 的用法说明和测试。

# Herdr 任务收尾

- 任务完成后，先把需要保留的结论、验证结果和未完事项记录到合适的位置（本地文件、Paraself 待办清单或其它），再关闭本任务创建且不再使用的 Herdr tab（用户 2026-11-11 补充）。只关闭明确属于本任务的 tab；其它任务或仍在运行的工作不随收尾清理。
