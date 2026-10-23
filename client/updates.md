# 客户端更新发布

支持 Windows x64（`.exe`）、macOS Apple Silicon（`.dmg`）、macOS Intel（`.dmg`）。三种包分别发布，客户端根据自身编译平台与架构选择清单。稳定版本采用三段 SemVer。

## 更新源与回退

顺序为当前业务服务 → 可选公网 HTTPS 源 → GitHub Releases。内网或公网明确返回 `204`、或返回不高于当前版本的有效清单时停止检查。连接、超时、404/408/410/429/5xx 才进入下一来源；401/403、普通 400、错误清单、目标不符、摘要和签名失败均不回退。

旧服务端仅支持 Windows 更新。macOS 请求收到其明确的 `400 unsupported_update_target` 时，视为该来源不支持当前平台并继续回退；其他 400 仍报错。这项兼容不需要更改或重启旧服务端。

外部请求使用独立匿名客户端，不发送业务 Token、Cookie 或代理凭据。普通公网源禁止重定向，安装包必须与清单同源 HTTPS。GitHub 清单来自同一仓库 Releases，允许 HTTPS 重定向到该仓库的 releases 路径以及 GitHub 的 `release-assets.githubusercontent.com`、`objects.githubusercontent.com`，最多五次。安装包 URL 必须固定到同仓库 `releases/download/v<version>/<fileName>`，不能指向其他仓库或 latest 别名。

下载源不可用时，从下一个来源重新取得清单；只有版本、字节数、SHA-256、签名全部与原清单一致才重新下载。部分文件会丢弃，不拼接不同来源的内容。

## 构建配置

Rust 编译时读取以下变量，运行时修改无效：

- `RIGHTDATA_UPDATE_PUBLIC_KEY`：可选覆盖内置 `client/update-public-key.pub`，支持 Minisign 公钥文本或单行 Base64。无效密钥会禁止下载和安装。
- `RIGHTDATA_PUBLIC_UPDATE_URL`：可选公网 HTTPS 清单。自动追加 `platform`、`arch`、`currentVersion`；空字符串等于未配置。
- `RIGHTDATA_GITHUB_REPOSITORY`：默认 `WnagoiYy/RightData`。

GitHub Actions 的 `RIGHTDATA_PUBLIC_UPDATE_URL` 仓库变量用于给官方包配置中间公网源。仓库未设置该变量时，内网不可用后直接使用 GitHub。

## 发布与签名

发布工作流见 [部署说明](../deploy/github/README.md)。最终安装包使用独立 Ed25519 发布密钥生成 Minisign 预哈希签名，客户端流式验证大小、SHA-256 和签名，并在启动安装前再次校验文件。发布私钥只保存在本机排除目录和 GitHub Actions 的 `RIGHTDATA_UPDATE_SIGNING_KEY` Secret，公钥随源码和客户端发布。

macOS 的 ad-hoc 代码签名与更新包的发布签名用途不同：前者用于应用包结构与运行，后者验证更新包来自同一发布身份。ad-hoc 不包含 Apple Developer ID，也不意味着已经公证或自动获得 Gatekeeper 信任。

每个 Release 提供安装包、`.minisig` 和 `latest-<platform>-<arch>.json`。清单示例：

```json
{
  "id": "github-0-1-1-macos-arm64",
  "version": "0.1.1",
  "platform": "macos",
  "arch": "arm64",
  "signature": "<完整 Minisign 文本>",
  "sha256": "<64 位十六进制摘要>",
  "size": 12345678,
  "fileName": "RightData-0.1.1-macos-arm64.dmg",
  "downloadUrl": "https://github.com/WnagoiYy/RightData/releases/download/v0.1.1/RightData-0.1.1-macos-arm64.dmg"
}
```

内网发布相同安装包时，仍使用 `/api/v1/client-updates/<id>/download`。目前旧服务端只接受 Windows x64，Mac 使用上述兼容回退；不要求改动正在运行的服务端。

## 用户安装

下载校验不自动安装。用户显式确认后，Windows 通过标准 UAC 启动 NSIS；macOS 打开 DMG，用户退出客户端后将新应用拖入 Applications 并替换旧版本，下次启动更新其用户级网络服务。更新包不包含 WebView 运行时。

原生单元测试和 CI 构建不能替代目标电脑上的首次安装、覆盖升级、系统登录启动与卸载验收。
