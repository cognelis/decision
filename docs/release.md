# Decision macOS 发布

Decision 目前只构建 Apple Silicon macOS 版本。`v1.0.0` 在 GitHub 只发布经过审计的源码，不附带本地 ad-hoc ZIP。仓库明确区分本地验证包和未来经过 Developer ID 签名、公证的公开发行包，二者不能混用。

## 两种构建模式

| 模式 | 签名与公证 | 用途 |
| --- | --- | --- |
| 本地 | ad-hoc 签名；关闭 hardened runtime；不公证 | 开发、布局测试、隔离冒烟 |
| 正式 | Developer ID Application；启用 hardened runtime；Apple 公证 | 公开下载和后续更新来源 |

没有设置 `DECISION_RELEASE=1` 时，Forge 只生成本地验证包。正式模式缺少签名身份、公证配置不完整、混用两种公证策略，或把身份写成 `-` 时，会在打包前失败。

## 本地发布演练

```bash
npm ci --ignore-scripts
npm run release:local
```

该命令依次运行完整质量门、严格语义门、生成 ZIP、启动隔离的打包 App 冒烟，再解压最终 ZIP 并校验其中唯一 App 的版本、签名和禁带内容。校验不信任旁边的构建目录，因此不能用另一个 App 替代待发布 ZIP 的内容。输出包括：

```text
out/make/zip/darwin/arm64/Decision-darwin-arm64-<version>.zip
out/release/Decision-darwin-arm64-<version>.zip.sha256
out/release/decision-darwin-arm64.json
```

本地清单的 `updatePolicy` 固定为 `manual`。它可以验证构建是否可复现地指向同一 ZIP，但 ad-hoc 包不能公开发布。

## 正式签名与公证

正式发布需要把 Developer ID Application 证书安装在受保护的 macOS arm64 构建机钥匙串中。签名身份只保存证书名称，不保存私钥：

```bash
export DECISION_RELEASE=1
export DECISION_SIGNING_IDENTITY='Developer ID Application: Example Team (ABCDE12345)'
export DECISION_RELEASE_TAG='v1.0.0'
```

公证凭据只能选择以下一种方式。

### 钥匙串配置

先在构建机上用 Apple `notarytool store-credentials` 建立配置，再设置：

```bash
export DECISION_NOTARY_KEYCHAIN_PROFILE='decision-release'
# 非默认钥匙串才需要：
export DECISION_NOTARY_KEYCHAIN='/path/to/release.keychain-db'
```

### App Store Connect API Key

把 `.p8` 私钥作为 CI 私密文件注入构建机，再设置：

```bash
export DECISION_APPLE_API_KEY='/private/path/AuthKey_ABCD123456.p8'
export DECISION_APPLE_API_KEY_ID='ABCD123456'
export DECISION_APPLE_API_ISSUER='00000000-0000-0000-0000-000000000000'
```

不要把证书、`.p8` 文件、密码、钥匙串或上述真实值提交到仓库。准备好环境后执行：

```bash
npm ci --ignore-scripts
npm run release:distribution
```

正式校验除本地检查外，还要求：

- 运行时依赖的 npm 安全审计没有任何级别的已知漏洞；
- ZIP 版本与 `package.json` 一致，`v<version>` 标签真实、精确地指向当前提交；命令参数、项目环境变量与 GitHub 标签来源不一致时直接失败；
- App 的严格代码签名有效且 Authority 为 Developer ID Application；
- Gatekeeper 评估通过；
- Apple 公证票据已经 staple 到 App 并可验证；
- App 内没有 DuckDB、GGUF 权重、自动更新元数据或其它已禁止内容；
- App 的稳定 Bundle ID 为 `com.cognelis.decision`。

只有正式校验全部通过后，才可以把 ZIP、`.sha256` 和 JSON 清单上传到同一受保护的 GitHub Release。上传和发布是独立的受保护操作，仓库脚本不会自行改变远端 Release。`v1.0.0` 不满足这条二进制发行条件，因此保持源码发布。

## GitHub 质量流水线

完整测试和发行都依赖可启动 Electron 的 macOS 环境，正式发行还依赖本机钥匙串。创建真实 GitHub Actions 工作流前，应先注册受保护的 macOS arm64 runner，再按以下阶段配置。

普通分支和 Pull Request：

```text
checkout
npm ci --ignore-scripts
npm run quality
```

受保护的 `v*` 标签：

```text
checkout
npm ci --ignore-scripts
注入签名/公证私密环境变量
npm run release:distribution
上传 out/make/...zip 与 out/release/*
人工批准后创建或更新 GitHub Release
```

`npm run quality` 是仓库的唯一 CI 质量入口，包含类型检查、全部自动化测试和严格语义识别门禁。流水线不得只运行非阻塞的 `report:semantic`。

正式发布额外执行 `npm run audit:runtime`。这项联网检查只审计会随应用交付的运行时依赖，任一安全告警都会阻止发行；它不放进普通的本地质量入口，以免离线开发被注册表可用性阻断。

截至 2026-08-14，运行时审计为 0。完整开发依赖审计仍报告 25 项构建期告警（1 项 critical、21 项 high、3 项 low），都位于 Electron Forge / Packager / Rebuild / Inquirer 的打包工具链。已经在既有兼容范围内升级 `brace-expansion`、`undici`、`fast-uri`、`ip-address`、`nanoid` 与 `postcss`；剩余问题主要被上游的 `tar@6`、`extract-zip@2.0.1` 和 `tmp@0.0.33` 范围约束。不要用跨主版本 override 强行“清零”：应在受保护、一次性的构建机上仅处理可信源码与官方 Electron 制品，并在 Forge 上游发布兼容修复后升级、重跑完整质量门和打包冒烟。

当前未提交 `.github/workflows` 模板：实际 runner 标签、制品库标识和密钥变量尚未配置，提交虚构值会制造“已有流水线”的假象。配置完成后，应只让受保护标签和受限成员访问发行阶段。

## 发布可移植性与秘钥审计

2026-08-14 的 `v1.0.0` 候选审计覆盖全部已跟踪文件和未忽略的新文件，并由 `scripts/test/release-portability.test.ts` 持续检查：

- 当前工作树没有私钥头、常见云服务或代码托管 Token 格式、带账号密码的 URL，也没有 `.env`、`.pem`、`.p8`、`.p12`、`.pfx`、`.key`、凭据 JSON 或钥匙串文件；这些常见本地凭据文件也由 `.gitignore` 默认阻止进入版本库；
- Forge 只读取签名、公证环境变量；文档中的身份、Key ID、Issuer 和文件位置都是不可用的显式占位符；
- 模型服务秘钥只通过 Electron `safeStorage` 加密后写入用户自己的 `app.getPath("userData")` 目录，文件与目录权限分别收紧为 `0600` 和 `0700`；
- 仓库位置、用户目录、Obsidian 库、客户端可执行文件和运行时文件都来自应用目录、系统用户目录、设置、环境变量或客户端发现，不依赖维护者机器路径；
- 旧 Git 提交中仍保留已经失效的非秘钥个人路径字符串；当前树和发布制品已移除这些字符串。彻底删除历史需要协调所有协作者进行破坏性的历史改写，本次发布准备不执行该操作。

该审计按文件内容而非少量扩展名识别文本，因此也覆盖 Swift、Objective-C++ 等后续可能加入的源码。它验证的是已知格式和可移植性边界，不能替代受保护构建机的秘钥管理、GitHub 的服务端秘密扫描或 Apple 证书轮换。

## 更新策略

`v1.0.0` 是源码 Release，不提供可安装二进制。只有正式签名与公证链路通过后，后续版本才会提供人工下载的 ZIP 和相邻 SHA-256；App 不在后台访问版本服务器，也不自动替换自身。

只有同时满足以下条件后，才启用自动更新：

1. 正式 Developer ID 和公证链路已经在受保护构建机上持续通过；
2. 确定稳定的 HTTPS 更新源、保留策略和回滚版本；
3. 更新源提供不可变 ZIP 和适配 Squirrel.Mac 的响应；
4. 下载失败、签名不匹配、回滚、用户提示和隐私说明都有集成测试。

Electron Forge 的 macOS 自动更新要求已签名 App；DMG 作为人工安装入口时仍需同时保留 ZIP 作为更新制品。当前 JSON 清单已固定版本、平台、架构、文件名、字节数和 SHA-256，可作为未来生成更新 feed 的输入，但 App 在本阶段不会读取它。

## 参考

- [Electron Forge：macOS 签名与公证](https://www.electronforge.io/guides/code-signing/code-signing-macos)
- [Electron Forge：自动更新](https://www.electronforge.io/advanced/auto-update)
