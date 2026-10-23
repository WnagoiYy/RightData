# dacp 后端部署

- 主机：`dacp-internal` SSH 配置指向 dacp；内网服务为 `http://192.168.3.123:8003`，监听 `0.0.0.0:8003`。
- 根目录：`C:\ProgramData\RightDataServer`。`data` 独立于版本目录，首次初始化新实例。
- `config.json` 是部署时生成的 GoFrame 配置入口，和版本 ZIP 分离；监听地址、数据目录与凭据由启动脚本注入。
- `RightData-Server` 计划任务以 SYSTEM 身份开机启动；凭据、数据及部署脚本仅 SYSTEM 和本机管理员可读写。
- `credentials.json` 保存初始管理员账号、密码和保护主密钥。不得上传 GitHub；完整恢复时必须保留该文件。服务日志不包含密码。
- Windows 防火墙允许本地子网访问 TCP 8003；文档 Cookie 保持 Secure，桌面业务使用 Bearer Token。

GitHub 发布工作流在 `v*` 标签上执行后端 Go 测试、前端和 Rust 测试，生成三个客户端包、后端 Windows x64 ZIP 和 Linux x64 tar.gz，全部成功才发布。后端包带离线 DuckDB 扩展、SHA-256 与 Minisign 签名；Windows 包附带所需 MinGW DLL。Linux 的安装、依赖和备份说明见 [Linux 部署](linux/README.md)。

dacp 不直接访问 GitHub。先在联网机器取得同一次 Release 中的后端 ZIP 和 `latest-server-windows-x64.json`，再执行：

```powershell
./deploy/server/deploy-ssh.ps1 -PackageDirectory ./test/artifacts/release-0.1.3
```

部署脚本通过 SSH/SCP 传输，dacp 使用预置公钥验证包、版本和签名，然后停止旧进程、备份静止数据、启动新版本并验证实例 ID 和就绪状态。健康检查失败时保留失败数据并恢复旧版本和备份。相同或更低版本不会重装。备份保留在 `backups`，由管理员按保留策略清理。

本方案的 GitHub 构建发布自动执行；向私网 dacp 的部署需要从可 SSH 访问的机器运行上述命令，不依赖常驻代理或公网入站端口。

正式客户端首次启动默认 `192.168.3.123:8003`，debug 测试构建默认 `127.0.0.1:8003`。已保存的连接设置优先，升级不会覆盖用户地址。
