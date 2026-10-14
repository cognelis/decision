# Decision 命名约定

2026-09-10，用户明确要求当前产品全面使用 Decision 命名，并取消早期品牌别名与顶部界面隐喻。此约定取代此前在 1.x 中保留兼容入口的安排。

| 对象 | 当前名称 |
| --- | --- |
| 产品 | Decision |
| 组织 | Cognelis |
| MCP 服务注册 | decision |
| CLI 入口 | decision-bridge；Windows 为 decision-bridge.cmd |
| workspace 包 | @cognelis/decision-* |
| macOS Bundle ID | com.cognelis.decision |
| 环境变量 | DECISION_ 前缀 |
| Hook 标记 | DECISION_HOOK=1；Windows 为 DECISION_HOOK=2（经 cmd 运行，作为最后一个参数） |
| Markdown 结构标记 | `<!-- decision:` |
| 默认应用数据目录 | macOS / Windows 使用 Decision，Linux 使用 decision |
| 界面术语 | 决策面板、理由面板、紧凑面板 |

当前运行时不再发现旧品牌目录、不回退到旧环境变量，也不打包额外的旧命名入口。新安装和接入只生成上表中的名称。历史源码中的界面术语与示例文档同步清理，原始历史可从 Git 查阅；发布检查禁止旧术语重新进入当前源码、文件名和文档。

已有决策不得因命名修改而丢失或改变选择、理由和结果。早期笔记先通过一次性迁移更新结构标记，保存原始字节和校验清单，并核对解析后字段；运行时随后只读取当前格式。恢复早期备份时也应先完成格式迁移，再重建索引。

本机旧应用数据目录已完整归档，未删除或重放未知队列。客户端注册名、命令路径、Hook 标记与相关 Skill 同步更新；既有客户端连接缓存的工具命名需要通过重新连接或重启客户端刷新。
