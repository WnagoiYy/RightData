# 跨平台发布

源码仓库：<https://github.com/WnagoiYy/RightData>。发布流程由 `.github/workflows/release.yml` 执行，维护源为本目录的 `workflows/release.yml`。

| 目标 | GitHub Runner | 安装包 |
| --- | --- | --- |
| Windows x64 | windows-latest | NSIS `.exe` |
| macOS Apple Silicon | macos-15 | `.dmg` |
| macOS Intel | macos-15-intel | `.dmg` |
| 后端 Windows x64 | windows-latest | 签名 `.zip`，含离线 DuckDB 扩展 |
| 后端 Linux x64 | ubuntu-latest / manylinux_2_28 | 签名 `.tar.gz`，含离线扩展及 systemd 安装脚本 |

包均不包含 WebView 运行时。Windows 使用已安装的系统 WebView2，macOS 使用系统 WebKit；macOS 最低声明版本为 12.0。应用与内嵌网络服务均按目标原生架构构建。

## 自动发布

1. 同步 `client/package.json`、npm lock、两个 Cargo 清单与 lock、`tauri.conf.json` 的版本。
2. 先在发布提交创建并推送 `v<版本>` 标签；需要手动发布时也使用该标签，并勾选 `publish`。发布脚本核对标签指向的提交与构建提交一致。
3. 每个平台执行网络服务和客户端 Rust 单元测试、发现协议测试及前端构建。Windows 验收真实 NSIS 首装、升级、服务重启、卸载重装；两种 Mac 架构均运行 Unix socket 测试，并挂载最终 DMG、校验签名与架构、启动 `.app`、检查 LaunchAgent 和服务重启后的身份保留。
4. 后端执行 Go vet、构建及完整集成测试，并打包所需依赖。
5. 构建最终包、生成更新签名和清单，三个客户端和后端全部成功后才一次发布 Release。已有同名版本不会被覆盖。

若五个构建任务均成功、只有发布步骤失败，可运行 `Publish verified build`，填写原构建 run ID。该流程核对同仓库发布工作流、五个构建结果和版本标签后复用原包，不重新编译，也不覆盖已有 Release。

## 构建测试与缓存

手动运行 `RightData release` 时默认只构建测试，不发布 Release。勾选 `windows_only` 只验证 Windows 客户端，包括真实 NSIS 安装生命周期，适合安装问题回归和缓存耗时对比；此模式不能发布。需要所有平台构建时保持未勾选。

CI 固定使用已验证的 Rust 1.99.1。网络服务缓存放在 `client/network-service/target/`，客户端缓存放在 `client/target/`；两个独立依赖图不能共用同一个被 rust-cache 分别清理的目录。构建失败时仍保存已编译的依赖。首次使用新缓存键需要完整构建，后续同工具链和依赖的构建复用缓存；本项目代码变化后的优化与链接仍会执行。

`RIGHTDATA_UPDATE_SIGNING_KEY` 是 Actions Secret，只用于最终包签名；`client/update-public-key.pub` 是随客户端编译的验证公钥。私钥不得进入 Git 历史。自建公网更新源使用可选仓库变量 `RIGHTDATA_PUBLIC_UPDATE_URL`，不设置时会跳过该来源。更新策略见 [客户端更新](../../client/updates.md)。

`sign-release.mjs` 使用标准 Ed25519/BLAKE2b 生成 Minisign 预哈希签名；测试夹具由原生 `minisign-verify` 验证，避免仅由签名脚本自身验证。

发布成功后自动运行 Verify published release，也可手动运行或在本机执行 `node deploy/github/verify-release.mjs`。它通过 latest URL 获取五份清单，重新下载三个客户端包和两个后端包，与 GitHub 资产大小/摘要对照，并独立校验 Ed25519 包签名、trusted comment 签名和 `.minisig` 附件。只使用公开公钥，不读取发布私钥。本机需要 curl 访问代理时可设置 `RIGHTDATA_VERIFY_CURL=1`。dacp 无 GitHub 网络，使用本机下载并通过 [SSH 部署脚本](../server/README.md) 传输；GitHub 不直接连接私网主机。

## 本机构建

在对应目标系统安装 Node.js、Rust 与系统开发工具，执行 `npm ci --prefix client`。设置发布签名 Secret 环境变量后，在项目根目录运行：

```text
node deploy/github/build-release.mjs x86_64-pc-windows-msvc
node deploy/github/build-release.mjs aarch64-apple-darwin
node deploy/github/build-release.mjs x86_64-apple-darwin
```

每次只运行与本机构架对应的一行。产物位于 `test/artifacts/release/`，编译缓存位于 `client/target/` 和 `client/network-service/target/`。Windows 单独打未发布安装包仍可使用 `deploy/windows/package-windows.ps1`。

## macOS 安装与服务

打开 DMG，将应用拖到 Applications。应用采用 ad-hoc 签名，没有 Developer ID 或 Apple 公证，首次打开可能需要在系统安全设置中手动允许。请核对 Release 来源和摘要。

首次启动将网络服务复制到 `~/Library/Application Support/RightData/network/bin/`，并创建 `~/Library/LaunchAgents/com.rightdata.network.plist`。服务属于当前登录用户，不请求 root 权限。客户端退出后服务保持运行；用户注销后由系统停止。客户端需要连接时按需启动，首次成功登记且用户未明确选择偏好时启用登录启动；用户手动关闭后不会被重新自动开启。

本机控制 socket 仅当前用户可读写（0600），服务数据目录为 0700，连接验证对端 UID。独占文件锁阻止双实例；崩溃后的同用户旧 socket 可在下次启动恢复。

升级前退出客户端，将新应用替换进 Applications；下次启动会停掉本应用自己的旧 LaunchAgent，原子替换服务程序，保留设备身份和连接配置。

卸载时退出客户端，执行下面命令仅移除本应用的启动项，再删除 Applications 中的应用：

```sh
launchctl bootout "gui/$(id -u)/com.rightdata.network"
rm "$HOME/Library/LaunchAgents/com.rightdata.network.plist"
```

数据默认保留在 `~/Library/Application Support/RightData/network/`。上述命令不删除业务数据。Windows 生命周期见 [Windows 部署说明](../windows/README.md)。

## 源码公开范围

`stage-source.mjs` 将源码整理到本目录下的 `repository/`，避免在原工作区根目录生成 Git 元数据。它排除数据库、凭据、运行目录、缓存、安装包、个人聊天研究记录和本机配置；服务端配置以 `config.example.yaml` 发布。使用前复制为 `config.yaml` 并按环境设置。该脚本生成的 `.github/` 与 `.gitignore` 是发布仓库中的必要固定路径。

构建成功与单元测试通过不等于已完成所有目标系统的图形界面安装、覆盖升级、登录恢复和卸载验收；这些须在实际目标系统中确认。
