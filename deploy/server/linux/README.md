# Linux x64 后端

面向海光 C86（x86_64）及 BC Linux 22.10，最低 glibc 2.28。构建在 glibc 2.28 容器内进行；随包 `preflight.sh` 检查目标系统架构、主程序和离线扩展的动态库。BC Linux 的具体补丁版本与海光实机仍需在公司服务器验收。无需安装 Go、Node.js、Python 或独立数据库服务。

## 安装

从同一 GitHub Release 取得 `RightDataServer-版本-linux-x64.tar.gz`、对应 `.minisig` 和 `latest-server-linux-x64.json`，在联网机器先核对清单 SHA-256，并使用仓库 `client/update-public-key.pub` 验证 Minisign 签名，再将完整包传入服务器。公钥可写为 minisign 的 `-P` 参数；验证命令为 `minisign -Vm 包名.tar.gz -P 公钥内容`。

```bash
mkdir rightdata-package
tar -xzf RightDataServer-版本-linux-x64.tar.gz -C rightdata-package
cd rightdata-package
bash preflight.sh
sudo bash install.sh
sudo systemctl status rightdata-server
curl --fail http://127.0.0.1:8003/api/probe
```

安装脚本依赖系统自带的 bash、coreutils、glibc/ldd、systemd、shadow-utils、openssl 和 curl。首次安装创建 `rightdata` 系统用户，以该用户运行后端，监听 `0.0.0.0:8003`。按公司网络策略开放所需来源的 TCP 8003；安装脚本不改动防火墙或 SELinux。

程序在 `/opt/rightdata/版本`；`current` 指向当前版本。数据在 `/var/lib/rightdata`，保护主密钥在 `/etc/rightdata/server.env`（root 600）。完整备份必须同时包含数据和该密钥；丢失密钥无法解密数据库。

初始用户名为 `admin`，密码在安装时随机生成，使用以下命令在服务器终端查看，登录后修改：

```bash
sudo bash -c 'set -a; . /etc/rightdata/server.env; RIGHTDATA_PRINT_INITIAL_PASSWORD=1 /opt/rightdata/current/rightdata'
```

公司服务器实际 IP 尚未提供；客户端连接设置填写其实际 IP 和 8003 端口。现有正式客户端的默认 dacp 地址保持不变。

## 升级与备份

先验证新包签名，解压并执行预检。停止 `rightdata-server`，备份 `/var/lib/rightdata` 和 `/etc/rightdata`，再把新包的 `rightdata`、`resource`、`build.json` 放入新的 `/opt/rightdata/版本`（root 所有、普通用户不可写）。切换 `current` 符号链接后启动服务，验证 `/api/probe`、登录和数据读取。失败时停止服务，恢复旧链接及停机备份后再启动；不要混用新版本写入的数据和旧版本程序。安装脚本发现已有配置会停止，避免重置密钥。

日志：`journalctl -u rightdata-server`。迁移时保留文件权限，并将数据与密钥一起恢复。
