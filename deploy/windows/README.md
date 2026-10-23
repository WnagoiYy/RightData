# Windows 安装包

本目录提供 x64 Windows 的 NSIS 打包和 `RightDataNetwork` 服务生命周期脚本。安装包采用每机安装，网络服务以 `LocalSystem` 运行，并将本机控制权限绑定到执行首次安装的交互式 Windows 用户。服务首次注册为手动启动；客户端需要连接且服务尚未运行时，可以按需启动固定的 `RightDataNetwork` 服务。

首次安装使用 Windows WTS 接口查询安装器所在桌面会话，兼容 32 位 PowerShell 调用、远程桌面及以另一管理员身份进行 UAC 提权。升级保留已绑定 SID，不重新依赖 Explorer。首次安装要求控制台或远程桌面存在已登录用户，不支持 SYSTEM 会话 0 的无人值守首次绑定。

## 生成安装包

构建机需要 Node.js、已安装依赖的 `client/node_modules`、Rust MSVC 工具链、Windows SDK 和可用的 PowerShell 5.1。首次构建需要取得 Rust 和 npm 依赖。安装包不包含、下载或安装 WebView2，目标电脑需已具备系统 WebView2 Runtime。

在项目根目录执行：

```powershell
npm.cmd --prefix .\client ci
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File .\deploy\windows\package-windows.ps1
```

脚本先以 `--locked` 构建独立网络服务，再调用 Tauri 生成 NSIS 安装包。默认目标为 `x86_64-pc-windows-msvc`，网络服务输出到：

```text
client\target\x86_64-pc-windows-msvc\release\rightdata-network-service.exe
```

NSIS 安装包通常位于：

```text
client\target\x86_64-pc-windows-msvc\release\bundle\nsis\
```

如需单独检查服务构建，可以执行：

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File .\deploy\windows\build-network-service.ps1 `
  -Profile Release `
  -Target x86_64-pc-windows-msvc
```

`service-defaults.json` 是安装约定的可读清单，不是安装器直接读取的配置入口。修改它不会改变安装行为；服务注册逻辑以 `service-lifecycle.ps1` 为准。

## 安装行为

安装程序需要管理员权限，并执行以下动作：

1. 升级时停止已有的 `RightDataNetwork` 服务并等待其退出。
2. 将 `rightdata-network-service.exe` 安装到应用目录。
3. 首次安装时注册手动启动的 `LocalSystem` 独立进程服务；升级时更新程序路径，但保留用户当前选择的自动或手动启动方式。
4. 保留服务原有安全描述符，并给控制用户追加“查询状态、启动服务”两项服务权限。不会授予查询或修改服务配置、停止、删除服务及修改安全描述符的权限，`SYSTEM`、Administrators 和其他既有 ACE 保持不变。
5. 创建入站防火墙规则 `RightDataNetwork-Program-v1`，规则只指向本次安装的服务程序。
6. 将 `%ProgramData%\RightData\network` 的所有者设为 `SYSTEM`，只授予 `SYSTEM` 和本机管理员完全控制权限，然后为本次安装启动服务。手动启动类型只控制后续 Windows 启动行为，不妨碍安装完成后立即使用。

服务命令行固定包含：

```text
--service --data-dir "%ProgramData%\RightData\network" --controller-sid <SID>
```

首次安装从安装程序所在会话的系统 `explorer.exe` 获取控制用户 SID，只接受 `S-1-5-21-…-RID` 形式的账号 SID。该用户可以访问服务的本机控制管道，并在服务未运行时查询状态和请求启动固定服务，但不能查询/修改服务配置、停止或删除服务，也不能写入共享服务数据目录。客户端只在默认生产管道缺失时尝试按需启动；设置了测试用自定义管道时不会操作 SCM。使用会话 0、没有交互式桌面的软件分发账号执行首次安装会因无法确定控制用户而失败；当前安装包没有命令行参数用于覆盖控制 SID。需要绑定指定用户时，应在该用户的交互式会话中启动安装并通过 UAC 提权。

升级会从已有服务的 `ImagePath` 读取并复用控制 SID，重新校正上述最小启动权限，并保留服务原有 DACL 中的其他 ACE。重新运行升级安装不会把控制权迁移给另一个用户。需要更换控制用户时，先正常卸载服务，再从新用户的交互式会话重新安装；保留的设备数据可继续使用。

用户在客户端关闭“开机启动”后，服务保持手动启动。Windows 重启后服务不会自行运行；该用户下次启动客户端并需要网络连接时，客户端可以用最小服务权限按需启动它。按需启动不会把启动类型改回自动。

首次成功登记后，只有 `%ProgramData%\RightData\network\startup.json` 尚不存在、即用户从未明确选择开机启动偏好时，服务才会把启动类型从手动改为自动。用户在客户端选择开启或关闭都会持久化为显式偏好；显式 `false` 会跨服务进程和 Windows 重启保留，后续登记不会重新开启。修改启动类型只允许由已经作为 `RightDataNetwork` SCM 服务运行的进程执行；独立命令行或调试进程会拒绝该操作。桌面客户端只能在默认管道缺失且操作为状态查询或显式启动时调用 SCM `StartService`，不会安装服务、修改启动类型、停止或删除服务；自定义测试管道不会触发 SCM。

## 预置连接地址

正式构建的默认业务地址是 `http://192.168.3.123:8003`，开发构建使用 `http://127.0.0.1:8003`。v0.1.7 默认发现地址为 `https://39.106.128.14`，首次升级会补齐旧版空发现地址，保留自定义地址；之后仍可手动清空。控制用户可在客户端“连接设置”中修改，设置同时写入客户端状态和网络服务配置。连接设置不再随启动或连接失败自动弹出。

批量部署可以在首次安装前预置 `%ProgramData%\RightData\network\network.json`。安装程序会保留该文件并收紧目录权限。示例：

```json
{
  "serverUrl": "https://rightdata.example.internal",
  "discoveryUrl": "https://39.106.128.14",
  "boundInstanceId": null,
  "allowPublicRelay": false,
  "enabled": true
}
```

业务地址和发现地址只能包含协议、主机及端口，不能包含账号、密码、业务路径、查询参数或片段。公网发现地址必须使用 HTTPS；只有本机回环发现地址允许 HTTP。首次探测成功后应用会保存服务实例标识，因此预置文件中的 `boundInstanceId` 应保持为 `null`。

服务已经安装时，优先通过客户端连接设置修改地址。部署工具直接更新 `network.json` 时必须以管理员身份先停止 `RightDataNetwork`，原子替换完整 JSON，再启动服务；不要在服务运行时分段写入文件。

## WebView2 运行时

默认 `webviewInstallMode.type = "skip"`，安装包不包含、下载或安装 WebView2 Runtime。目标电脑需已安装 WebView2；macOS 包使用系统 WebKit。旧版独立覆盖文件 `tauri-no-webview2.json` 与当前默认行为一致。


## 升级、身份与配置保留

`%ProgramData%\RightData\network` 不在程序安装目录内，升级和卸载均不会删除。这里包含：

- `device.key`：iroh 设备身份；
- `network.json`：业务地址、发现地址、已绑定的服务实例及网络开关；
- `network.jsonl`：本机网络日志。

因此覆盖升级会保留设备身份和连接设置。升级流程会先停止服务，再替换程序并启动服务，避免在运行中覆盖可执行文件。服务注册、控制 SID、数据目录 ACL 和固定名称的防火墙规则会在安装后重新校正。

客户端自己的连接设置、加密会话和待补报事件存放在 Tauri 的当前用户应用数据目录中，通常为 `%APPDATA%\com.rightdata.client`。Windows 服务生命周期脚本不会删除这些用户数据。

## 卸载与彻底清理

卸载器只停止并删除 `RightDataNetwork` 服务，以及删除 `RightDataNetwork-Program-v1` 防火墙规则。它有意保留 `%ProgramData%\RightData\network`，便于重装或升级后延续设备身份和连接配置，也不会主动删除各用户的 Tauri 应用数据。

确需重置设备身份或移交电脑时，应先完成卸载，再由管理员确认路径后删除 `%ProgramData%\RightData\network`。如需清除某个用户的登录恢复信息和连接设置，也应由该用户退出客户端后删除其实际的 Tauri 应用数据目录。删除这些目录会生成新的设备身份并要求重新配置、重新登录。

## 当前验证范围

已在 GitHub Windows runner 上通过真实 NSIS 首次安装、覆盖升级、服务停止与重启、卸载和重装，并核对控制用户 SID、启动偏好与设备身份保留。完整安装验收已加入发布工作流，必须通过后才能发布。另已验证 32/64 位 PowerShell 会话查询、带空格路径的 SCM 注册、服务 ACL 和防火墙规则。

安装器的 NSIS 原生 `System.dll` 与 .NET 程序集同名，因此会话查询使用已加载 .NET 程序集的绝对路径编译，避免临时目录中的 DLL 名称冲突。安装脚本失败会在安装目录保留 `rightdata-install-error.log`；静默模式会返回非零退出码。

从 PowerShell 7 启动安装器时，Windows PowerShell 5.1 子进程可能继承不兼容的模块搜索路径。安装脚本会在该子进程内限定到 Windows 自带模块，避免 `Set-Acl` 等系统命令加载失败。本机已验证中文目录下两次覆盖安装、服务重启及设备身份/连接配置保留。可在管理员终端对现有安装运行 `test/client/installer-local.ps1 -Package 安装包 -InstallDir 现有安装目录`；该测试会覆盖安装并重启客户端，不执行卸载。

尚未验证真实 Windows 10/11 桌面上的图形安装流程、企业软件分发、安装失败回滚及系统重启后的服务状态。客户端安装包不负责安装 WebView2 Runtime。

静态安装约定测试：

```powershell
node --test .\test\client\service-install-contract.test.mjs
```
