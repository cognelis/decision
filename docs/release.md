# Decision 跨平台发布

Decision `v1.1.0` 起默认发布 Windows x64 与 Apple Silicon macOS 两个原生桌面制品。项目免费、开源；没有商业签名证书时仍然发布，但必须如实展示系统告警、校验和与签名状态。已经公开的 `v1.0.0` 源码 Release 与标签保持不变。

## 发布目标

| 平台 | GitHub runner | 主制品 | 签名状态 |
| --- | --- | --- | --- |
| Windows x64 | `windows-latest` | `Decision-<version>-win-x64-Setup.exe` | `signature: "unsigned"` |
| Apple Silicon macOS | `macos-26` | `Decision-darwin-arm64-<version>.zip` | `signature: "ad-hoc"` |

每个主制品必须同时带同名 `.sha256` 和 `decision-<platform>-<arch>.json`。Squirrel 的 `.nupkg`、`RELEASES`、source map、测试 fixture、模型权重、SQLite、用户数据和本地凭据都不是公开附件。

## 源码构建

两个平台都使用 Node.js `>=22.13.0 <26` 与 npm，推荐 Node.js 22 LTS。Node.js 26 当前会触发上游 Electron ZIP 解压库静默退出，因此构建前置检查会明确拒绝它，而不会产生“命令成功但没有文件”的假结果。

通用步骤：

```bash
npm ci --ignore-scripts
npm run setup:electron
npm run check
npm run make
npm run smoke
npm run release:verify
```

Windows x64 不编译 Apple Foundation Models helper 或 Liquid Glass addon，并在包中验证这些 Apple 专用文件不存在。Windows bridge 使用 `.cmd` 入口，应用与 Obsidian 的默认目录从 Windows 系统环境解析。CI 必须静默安装最终 Setup，从实际 `%LOCALAPPDATA%/Decision/app-<version>` 目录执行完整冒烟并在结束后卸载；不能只启动 Forge 的未安装目录。

Apple Silicon macOS 需要 macOS 26 SDK 与 Xcode Command Line Tools，用于编译 Foundation Models helper；Liquid Glass addon 的最低运行目标保持 macOS 13.5，旧系统无法使用的 Apple 能力会降级而不阻止其它决策功能。无证书构建执行 ad-hoc 签名、关闭 hardened runtime 且不公证。

本机只能完整执行当前平台的安装包。Windows x64 与 macOS arm64 的最终验收都必须在 GitHub 原生 runner 上分别完成，不能用交叉编译代替启动、Hook、MCP、待处理队列、Markdown、SQLite 重建与退出清理的冒烟测试。

## 无证书告警

Windows unsigned 安装器可能触发 Microsoft Defender SmartScreen 的“未知发布者”提示。用户应只从官方 `cognelis/decision` Release 下载，先用相邻 `.sha256` 核对完整性，再从 SmartScreen 的“更多信息”界面确认文件名并继续。

macOS ZIP 中的 App 使用 ad-hoc 签名且未经过 Apple notarization。Gatekeeper 阻止首次启动时，用户应先核对 SHA-256，再在“系统设置 → 隐私与安全性”中对该次 Decision 启动选择“仍要打开”。文档不得建议全局关闭 Gatekeeper 或 SmartScreen。

SHA-256 只能证明下载内容与发布附件一致，不能证明发布者身份，也不能代替 Authenticode、Developer ID 或 Apple 公证。

## schema-v2 清单

平台校验器从最终主制品重新计算大小与 SHA-256，并写出如下结构；不能信任旁边未打包的应用目录：

```json
{
  "schemaVersion": 2,
  "product": "Decision",
  "version": "1.1.0",
  "platform": "win32",
  "arch": "x64",
  "artifact": {
    "name": "Decision-1.1.0-win-x64-Setup.exe",
    "bytes": 123456,
    "sha256": "<64 lowercase hex characters>"
  },
  "signature": "unsigned",
  "sourceCommit": "<40 lowercase hex characters>",
  "updatePolicy": "manual"
}
```

macOS 清单使用 `platform: "darwin"`、`arch: "arm64"` 与 `signature: "ad-hoc"`。聚合校验必须看到恰好六个文件，复算两个哈希，并确认产品、版本、来源提交和 `manual` 更新策略一致，且来源提交就是当前标签提交；缺少任一平台、出现多余附件、标签与版本不一致或提交不同都会阻断 Release。聚合校验保持零第三方依赖，避免发布 job 在干净 checkout 中因未安装构建依赖而失效。

## GitHub Actions 发布流

`.github/workflows/release.yml` 支持 `workflow_dispatch` 和 `v*` 标签：

1. `quality` 在 Ubuntu 使用锁文件安装，仅显式运行固定版本 Electron 的官方安装器，然后运行完整质量门、运行时依赖审计与发布可移植性扫描；
2. `build-windows` 在 `windows-latest` 原生构建、启动和校验 Windows x64；
3. `build-macos` 在 `macos-26` Apple Silicon runner 原生构建、启动和校验 macOS arm64；
4. `release` 等待前三项成功，下载两个平台各三个文件，执行完整集合校验，在不可见的 draft 中替换并回下载复核恰好六个附件及当前标签提交，最后一次性公开；已经公开的同名 Release 只校验、不改写。

两个平台都会扫描最终安装内容的路径与文本：ASAR 内全部文本条目和外层大文本都参与令牌、密码 URL 与用户主目录检测；依赖 source map、测试/fixture、缓存和非运行时 Markdown 在打包前剔除，而不是靠附件上传后忽略。

顶层权限只有 `contents: read`；仅标签触发的 `release` job 获得一次 `contents: write`。手工触发会完成双平台构建并保留 7 天的 Actions artifacts，但不会修改公开 Release。构建任务不接收仓库 secrets，也不使用维护者目录。

## 可选的正式签名

真实证书不是免费公开发布的前置条件。未来配置 Authenticode 或 Developer ID 时，应继续保持相同文件名、SHA-256、schema-v2 清单、双平台成对发布与人工更新策略，并把清单状态分别升级为 `authenticode` 或 `developer-id`。

macOS 的既有 `DECISION_RELEASE=1` 路径仍要求完整 Developer ID Application 身份和唯一一种公证策略；缺少或混用凭据时失败关闭。任何 `.p8`、`.p12`、`.pfx`、私钥、密码或钥匙串都不能提交到仓库。引入真实凭据属于新的权限与安全决策，需要另行批准。

## 移行与更新边界

跨平台封装不改变 Obsidian Markdown 格式、稳定编号或待处理协议。整个 1.x 系列继续读取旧品牌目录、环境变量、Hook、MCP 与 bridge 兼容入口；默认应用数据目录迁移发生在打开 SQLite、凭据、模型、spool 和未完成草稿之前。历史沉淀与尚未完成的 capture、candidate、semantic pair、理由和表单草稿都必须继续可读、可恢复、可处理。

更新策略固定为 `manual`。应用不访问版本服务器，也不会自动替换自身；新版本由用户从官方 GitHub Release 下载。Intel macOS、Windows ARM64、Linux、应用商店和自动更新不属于 `v1.1.0` 契约。

## 发布前检查

```bash
npm run quality
npm run audit:runtime
npx vitest run apps/desktop/test/brand-migration.test.ts apps/desktop/test/recovery.integration.test.ts scripts/test/release-portability.test.ts scripts/test/release-workflow.test.ts scripts/test/release-artifact.test.ts scripts/test/verify-release-set.test.ts
git diff --check
```

标签只在公开 `main` 的精确审阅提交上创建。先在 `main` 手工运行 workflow 验证两个原生平台；全部通过后再创建 `v1.1.0`，由同一 workflow 生成并发布附件，不上传开发机本地制品。
