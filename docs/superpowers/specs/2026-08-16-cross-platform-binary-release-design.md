# Decision 跨平台二进制发布设计

**日期：** 2026-08-16  
**状态：** 已批准；用户授权普通实施决策由 Codex 直接确定并记录  
**取代范围：** 取代 IMP-062、IMP-068 和既有发布文档中“未签名二进制不能公开发布”的限制；保留其中的源码审计、手工更新和有证书时优先签名公证原则

## 目标

从下一个正式版本开始，GitHub Release 默认同时提供可直接下载的 Windows x64 和
Apple Silicon macOS 安装制品。没有商业签名证书时仍然发布免费制品，但必须在
Release、下载说明和校验清单中明确告知系统安全提示及处理方式，不能让用户误以为
制品已经通过 Microsoft 或 Apple 身份认证。

本次工作延续品牌迁移的两条硬性要求：

1. 历史沉淀可用：升级和跨平台运行不能破坏已有 vault、决策、复盘、方法论、设置、
   模型配置与恢复点。
2. 待处理内容可用：capture、candidate、semantic pair、工作箱、表单草稿和发布状态等
   尚未完成的数据仍能被发现、读取并继续处理。

## 决策授权

普通依赖选择、脚本拆分、制品命名、CI 组织、测试范围和兼容实现由 Codex 采用风险
最低且维护成本合理的方案，不逐项请求用户决定。只有新增付费能力、申请或使用真实
签名凭据、改变 GitHub 公开范围、删除或不可逆迁移用户数据时再次请求批准。

## 采用方案

继续使用现有 Electron Forge，不迁移到另一套打包系统：

- Windows 在 GitHub 托管的 x64 Windows runner 上通过 Squirrel.Windows 生成安装器；
- macOS 在 GitHub 托管的 Apple Silicon runner 上继续通过 MakerZIP 生成 ARM64 ZIP；
- 两个平台分别构建和校验，由单独的聚合任务一次性创建或更新 GitHub Release；
- 发布不引入自动更新、收费服务、私有制品库或新的后台网络访问。

这条路线保留当前 Forge 配置、macOS 冒烟与制品清单，只补充 Windows maker 和跨平台
边界。相比整体迁移到 electron-builder，改动面更小；相比两个平台都只发 ZIP，
Windows 安装体验和开始菜单集成更完整。

## 发布制品契约

`v<package.json version>` 标签触发二进制发布。下一个版本为 `v1.1.0`，不重写已经公开
的 `v1.0.0` 源码版本。

每个 Release 至少包含：

| 平台 | 架构 | 主制品 | 配套文件 |
| --- | --- | --- | --- |
| Windows | x64 | `Decision-<version>-win-x64-Setup.exe` | 同名 `.sha256`、`decision-win32-x64.json` |
| macOS | arm64 | `Decision-darwin-arm64-<version>.zip` | 同名 `.sha256`、`decision-darwin-arm64.json` |

清单必须固定 schema 版本、产品版本、平台、架构、文件名、字节数、SHA-256、签名状态、
更新策略和来源提交。更新策略继续为 `manual`。Squirrel 生成的 `.nupkg` 与 `RELEASES`
属于构建中间产物，本阶段不公开，以免形成尚未实现的自动更新契约。

制品文件名、清单版本和 Git 标签不一致，任一平台缺少主制品，或校验值无法复算时，
整个发布失败，不创建只有一个平台的“成功”版本。

## 无证书发布与用户告警

无证书是受支持的公开发布模式，不是临时绕过：

- Windows 安装器可以没有 Authenticode 签名。Release 明确说明首次运行可能出现
  Microsoft Defender SmartScreen 的“未知发布者”提示，并建议用户只从官方
  `cognelis/decision` Release 下载、先核对 SHA-256，再选择继续运行。
- macOS App 使用 ad-hoc 签名，ZIP 不做 Apple 公证。Release 明确说明首次打开可能被
  Gatekeeper 阻止，并提供系统设置中“隐私与安全性”的图形界面放行步骤。默认文档不
  引导用户关闭全局 Gatekeeper，也不要求执行降低系统安全性的命令。
- JSON 清单如实写入 `signature: "unsigned"` 或 `signature: "ad-hoc"`，不能复用
  `verified`、`notarized` 等容易误导的状态。
- 如果未来配置真实证书，签名和公证校验应自动升级为严格失败关闭；本设计不要求购买
  证书，也不因免费发布而阻断无证书制品。

Release 正文同时说明项目免费、开源、无自动更新，并给出源码构建入口。所有警告使用
事实性语言，不声称绕过系统提示等同于制品安全；SHA-256 只证明下载完整性，不能替代
发布者身份签名。

## GitHub Actions 架构

新增一个只由 `v*` 标签触发、也可手工执行验证的 release workflow：

1. `quality` 在受支持环境运行仓库统一质量入口和发布可移植性审计；
2. `build-windows` 固定使用 `windows-latest` 与 x64，安装锁文件依赖，构建
   Squirrel 安装器，运行 Windows 结构冒烟和制品校验后上传内部 CI artifact；
3. `build-macos` 固定使用 `macos-26` Apple Silicon runner 与 arm64，构建 ad-hoc ZIP，运行隔离 App 冒烟
   和 ZIP 校验后上传内部 CI artifact；
4. `release` 依赖前三个任务，下载两个平台的制品、校验文件和清单，复核标签/版本/
   当前提交后，在不可见 draft 中重建并回下载校验恰好六个附件，最后一次性公开；已经
   公开的同名 Release 保持不可变，只允许复核其附件仍绑定当前标签提交。

手工触发默认只验证和保存短期 CI artifacts；只有运行所针对的 ref 是符合版本契约的
标签时才允许修改公开 Release。工作流使用最小权限：构建任务只读源码，聚合发布任务
才获得 `contents: write`。同一标签设置并发互斥，避免两个任务同时改写 Release。

## Windows 运行兼容

打出安装器不等于可用。实现必须补齐以下 Windows 边界：

- 进程最早阶段处理 Squirrel 安装、更新和卸载事件，事件处理完成后立即退出，不启动
  正常界面或本地数据服务；
- 增加 Windows `.ico` 图标，Forge 的 macOS `.icns` 与 Windows `.ico` 按平台选择；
- 原生 Foundation Models helper 和 Liquid Glass 插件只在 macOS 构建，Windows 构建
  将对应能力标记为不可用，不把可选能力缺失当作应用启动失败；
- bridge 同时生成 POSIX 与 `.cmd` 入口，运行时按平台选择；历史
  `decision-island-bridge` 兼容入口在整个 1.x 系列继续保留；
- Hook 命令按目标平台转义，不能把 POSIX 环境变量写法或单引号命令直接写进 Windows
  客户端配置；
- Windows 的 Obsidian 注册表文件从 `%APPDATA%/obsidian/obsidian.json` 发现，显式
  用户设置始终优先；
- 子进程启动、可执行文件发现和路径拼接使用平台 API，不依赖 `/bin/sh`、`.app`、
  `/Applications` 或维护者机器目录。

跨平台只改变程序容器和系统集成，不改写用户 Markdown 数据格式或稳定 ID。Windows
和 macOS 继续使用各自系统默认应用数据目录；用户显式选择或同步的 vault 可以跨平台
读取。并发从两个系统打开同一个同步 vault 不属于本次一致性承诺。

## 构建脚本与制品校验

平台分支集中在少量构建与发布模块中，业务代码不散落 runner 判断：

- Node 调度脚本根据 `process.platform` 选择是否编译 Apple 原生组件，避免 Windows
  workflow 依赖 shell 或 Xcode；
- 冒烟脚本根据平台解析 Forge 输出，验证主程序、资源、bridge、兼容入口和必要清单；
- 制品校验器接收显式平台、架构和输入文件，公共部分负责版本、文件名、哈希、禁带内容
  和清单，平台适配器负责 ZIP/App 或 PE/Setup 的结构检查；
- 检查从最终上传制品重新提取信息，不能信任同目录的未打包应用来替代附件内容；
- 发布前继续扫描当前树和制品中的私钥格式、账号令牌、带密码 URL、维护者绝对路径、
  `.env` 与证书文件；扫描覆盖 ASAR 内全部文本和外层大文本的分块内容，并拒绝上传
  source map、测试 fixture、模型权重和本地数据库。

Windows runner 无法验证 macOS Gatekeeper，macOS runner 也不解析 Windows
Authenticode。每个平台在原生 runner 上产生清单，聚合任务只复算跨平台通用字段并
保证两个结果成对出现。

## 测试策略

实施按测试先行覆盖：

1. Forge maker 选择、确定性文件名、平台图标和 Squirrel 早期退出；
2. Apple 原生组件构建脚本在 Windows 跳过、在 macOS 保持当前严格行为；
3. POSIX/Windows bridge 入口与新旧兼容名称；
4. Hook 命令在路径含空格和特殊字符时仍正确，且不覆盖第三方配置；
5. Windows/macOS Obsidian 配置发现与显式设置优先级；
6. 冒烟脚本对两种 Forge 输出的必需文件和禁带文件检查；
7. 两个平台清单的签名状态、版本、哈希、大小和来源提交；
8. workflow 的 runner/架构矩阵、最小权限、单点发布、手工运行保护和成对制品门禁；
9. 历史迁移 fixture 与所有待处理 fixture 在通用逻辑变更后继续通过；
10. 完整类型检查、自动化测试、语义质量门、运行时依赖审计和秘钥/路径可移植性审计。

由于当前开发机不能原生执行 Windows 安装器，Windows 完成条件包含 GitHub 托管
Windows runner 的真实 `make`、结构冒烟和校验成功；不能只凭本机静态测试宣称可用。

## 文档与版本管理

更新 README、构建说明、`docs/release.md`、实施决策日志和 Release 模板：

- 默认下载同时列出 Windows x64 与 Apple Silicon macOS；
- 明确两者无商业签名时的系统提示、SHA-256 校验方式和源码构建入口；
- 保留 macOS Developer ID/公证作为可选增强路径，而不是公开二进制的先决条件；
- 不承诺 Intel macOS、Windows ARM64、Linux、自动更新或应用商店发布；
- `v1.0.0` 保持不可变源码基线，跨平台制品与相关修复进入 `v1.1.0`。

## 完成条件

- Windows x64 与 macOS arm64 原生 CI 构建、冒烟和最终制品校验全部通过；
- 同一 `v1.1.0` Release 包含两种主制品、各自 SHA-256 和 JSON 清单；
- Release 与 README 明确展示无证书告警，不要求用户全局关闭系统安全能力；
- fresh install、历史沉淀 fixture、待处理 fixture 和品牌兼容入口均通过；
- 当前树、GitHub 公共树和最终附件不存在秘钥、维护者目录或本地用户数据；
- GitHub workflow 使用最小权限且只有聚合任务写 Release；
- 本地 Gitee remote 和既有 GitHub `v1.0.0` 标签、Release 与提交保持不变。

## 参考

- [Electron Forge：Squirrel.Windows Maker](https://www.electronforge.io/config/makers/squirrel.windows)
- [GitHub Docs：GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
