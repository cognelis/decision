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
  --output out/pr-review-replay/sample/run-1.json
```

使用现有 CLI 登录。运行会将所评审的源码交给该登录对应的模型服务；只对已获准用于该服务的仓库运行。可以用 `--model MODEL` 固定可用模型；默认沿用 CLI 默认模型，结果记录为 `codex-default`。要做严格跨版本比较应显式固定模型，并保留调用记录中的模型信息。

`--implementation /absolute/path/to/baseline` 可加载另一份代码快照的评审实现；该目录需要相同依赖和源码结构。结果保存实现路径、关键实现文件哈希、case 哈希、候选、最终报告、过程、用量与耗时。旧实现没有候选观测钩子时，从最终问题和过滤项恢复，并标为 `final-and-filtered`，不能据此统计更早的定位丢失。

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

同一真实缺陷被多条候选指出，召回只计一次。新发现的有效问题可先标 `true_positive` 且 `issueIds: []`，再核实是否扩充标签。未判定的候选不自动算误报；计分会明确列出未判定数量。

```sh
npm run replay:pr -- score \
  --run out/pr-review-replay/sample/run-1.json \
  --labels out/pr-review-replay/sample/labels.json \
  --judgments out/pr-review-replay/sample/judgments.json
```

输出已知缺陷的候选/最终召回、核验损失、已判定最终问题的精确率、未判定数和成本。未判定数非零时指标不完整；空分母返回 `null`。当前工具提供单样本计分，不能将一两个 PR 的结果当作整体召回提升。

## 本轮源码调查能力

评审和核验共用 `find_files`、`search_code`、`read_file`：按固定 SHA 枚举仓库，按文件/目录范围做字面搜索，支持 diff 基点和源提交源码。核验继承评审实际读取的源码，包含版本、位置和截断标记。

源码搜索每页最多扫描 60 个文件、约 20 处摘录，每文件显示前 3 处；文件查找每页最多 100 条。`nextOffset` 非空时应继续或缩小范围。文本搜索覆盖源码、配置和文档，排除常见生成文件；读取失败、目录截断和不支持均不等于没有命中。当前按平台逐文件取内容，大仓库宜先用路径查找缩小目录；若网络成本成为瓶颈，再引入本地固定版本索引。

GitHub 使用固定提交 Git tree，GitLab 使用固定 ref 的 repository tree，Bitbucket 使用目标仓库中的固定提交 files 接口；目录最多保存 20000 个文件，分页或平台截断会明确标为不完整。沿用认证、限流、取消和响应体上限。

本轮保留现有核验评分门槛、深度评审分工和每组调用上限，便于先观察取证能力的影响。真实模型回放与人工计分完成前，不宣称召回率已经提升。
