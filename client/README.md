# RightData 客户端

React + TypeScript + Ant Design + Tauri 2。界面在客户端组织业务，所有生产网络请求通过 Rust；独立网络服务负责直连、iroh 节点发现与传输。后端独立开发，本目录不包含后端副本。

## 开发

Windows 开发需要 Node.js、Rust MSVC 工具链、Windows SDK、系统 WebView2；macOS 开发需要 Node.js、Rust 和 Xcode Command Line Tools，使用系统 WebKit。

```powershell
cd client
npm ci
npm run dev
npm run tauri dev
```

已有 Vite 服务时直接构建和运行 Tauri debug 二进制，避免重复占用 1420 端口。浏览器预览可以查看登录页面；业务操作要求桌面原生桥接。测试桩只存在于 `test/client`。

网络服务单独构建：

```powershell
cargo build --manifest-path client/network-service/Cargo.toml --target-dir client/target --target x86_64-pc-windows-msvc
```

macOS 开发先在根目录运行 `cargo build --manifest-path client/network-service/Cargo.toml --target-dir client/target`，使原生调试客户端可找到同目录的网络服务。

独立开发实例使用绝对 `--data-dir`；Windows 安装版以 `LocalSystem` 注册到 SCM，首装启动类型为手动，安装结束会启动一次。默认生产管道缺失且客户端执行状态查询或显式启动时，客户端只尝试按需启动固定的 `RightDataNetwork` 服务；自定义 `RIGHTDATA_NETWORK_PIPE` 仅用于隔离测试，绝不触发 SCM。控制权限绑定安装用户 SID。安装、升级、卸载脚本位于 `deploy/windows`；不要为调试注册或覆盖已安装服务。

## 已实现的业务界面

- 登录、记住登录、会话恢复、修改密码、退出登录；主窗口隐藏至托盘，资源预览使用独立窗口。
- 用户及行列授权、角色/查询/报表/看板/菜单/通报/数据大屏配置；共享配置使用版本冲突检测。
- 数据集、表结构、结构化查询、SQL、记录和字段编辑；行列权限由服务端执行。
- Excel 本地解析、映射及导入任务；导出任务按完整结果生成 XLSX，保留 BIGINT/DECIMAL 文本精度。
- 数据库运维、文件管理、接口文档及在线调试、访问/查询/导入/导出日志、本机中转日志。
- 资源页仅使用资源接口和绑定查询。HTML 在不透明 sandbox iframe 中执行，受控取数，不接收业务 Token。
- 报表支持筛选参数映射、显示列与格式、默认排序、精确汇总、完整结果 CSV/XLSX、受主键约束的单表记录维护和授权资源钻取。
- 看板支持桌面/平板/手机画布、拖拽缩放和键盘布局，提供指标、表格、柱图、折线、饼图、文本、仪表盘和进度组件，以及汇总、排序、条数、参数映射和部分结果提示。
- 通报使用本地 Monaco 编辑器，支持 HTML/CSS/JavaScript 格式化、Ctrl+S、当前选区图片插入、绑定数据源测试和异步结果防串写；本地 worker 不依赖 CDN。
- PNG/JPEG、全屏和独立预览带入当前草稿与参数。数据大屏使用独立 ZIP 资源包、不可变版本和发布修订，客户端校验并缓存到版本目录后在受控容器中运行。
- 导出结果断网持久化、重启补报与幂等；客户端安装包下载后验证摘要和签名，再由用户主动启动安装。

页面延续旧版蓝白配色与品牌资产，按导航直接进入工具栏、表格和表单。

## 连接与安全边界

连接设置包含业务服务地址、发现服务地址和默认关闭的公网业务中继。发现协议参考 `deploy/discovery/README.md`；实际公网发现域名、证书及反向代理需按部署环境配置。

0.1.3 起，正式构建首次启动默认连接 `http://192.168.3.123:8003`；debug 测试构建默认 `http://127.0.0.1:8003`。客户端和独立网络服务使用同一份构建默认值。已保存的地址优先，升级不会覆盖用户的连接配置。dacp 后端部署见 [SSH 部署说明](../deploy/server/README.md)。

内网节点不需要业务登录即可注册并转发。节点只连接配置的固定业务端口；每个业务请求仍由后端鉴权。外网 peer 路径要求 HTTPS，客户端在端到端 TLS 内核对证书和服务实例，再发送凭据。设备身份与业务会话分离，退出登录不会注销设备身份。暂停网络服务会停止节点注册和本机传输。

首次安装保持手动启动。节点登记成功后，只有本机尚无明确开机启动偏好时才会把服务设为自动启动；用户在客户端明确选择 `true` 或 `false` 后，偏好写入服务数据目录并跨进程和 Windows 重启保留，明确的 `false` 不会被后续登记改回 `true`。修改启动类型只允许由已经处于 SCM 服务运行态的网络进程执行；桌面客户端本身只拥有查询状态和启动固定服务的最小权限，独立调试进程不能修改 SCM 配置。

业务 Token 只在 Tauri Rust 内存/加密持久化中保存；WebView 不使用 localStorage 保存凭据。切换服务实例需要明确确认；权限修订变化会清除当前页面的旧结果。

## 验证

```powershell
cd client
npm run build
npm run test:data
npm run test:ui
```

真实后端与原生测试脚本位于 `test/client`，只操作其创建的随机测试目录、账号与进程；报告位于 `test/results`。0.1.0 基线的 `npm run build`、TypeScript 检查、`cargo check --all-targets` 均通过；Tauri Rust 单元测试 33 项通过、1 项默认忽略，合并的客户端单元/契约检查 31/31 通过。启用 `RIGHTDATA_REAL_INTEGRATION=1` 和独立 18003 配置用例的完整 UI 套件 50/50 通过；原生 smoke 11 项、离线事件 6 项、完全退出 4 项、同机网络集成 9 项、Monaco 2 项、报表 3 项、任务恢复 3 项、真实看板 2 项和真实大屏 7 项也已通过。大屏容器 UI 5/5、独立模板 4/4、打包器 3/3 通过；模板新增真实 opaque sandbox iframe 中的查询按钮与 Enter 回归。服务端 38 项竞态回归通过，大屏 v1 定向回归 3 项通过，其中危险 ZIP 用例覆盖 52 个拒绝样本；正式契约见 [大屏 v1 协议](../server/docs/screen-v1.md)。逐项证据与尚未验证的部署条件见 `test/results/client-plan-coverage.md`，阶段性执行记录见 `test/results/client-validation.md`。构建成功不代表 Windows 安装升级或跨真实公网 NAT 已验证。当前自动化 peer 测试使用同机三个独立网络服务进程和真实 TLS/QUIC，证明传输、回退、节点故障切换、恢复直连和鉴权链路，不证明两个受限 NAT 之间一定可直连。关闭公网业务中继时不启用 iroh relay；可达 IPv6、端口映射或双方可达 UDP 地址仍影响实际成功率。[iroh 连通性配置](https://docs.rs/iroh/latest/iroh/endpoint/struct.Builder.html#method.relay_mode)。

复现原生大屏时，`RIGHTDATA_SCREEN_SESSION` 必须指向包含隔离 `baseUrl`、测试用户名和密码的会话 JSON；脚本只接受独立 loopback 端口，并拒绝 8003 和 18003。本轮使用 `test/runtime/screen-integration-0f5ec708f2074866bd2303b348a12c85/session.json`，默认的 `test/runtime/client-screen-session.json` 不存在。若系统 `py` launcher 不可用，通过 `RIGHTDATA_PYTHON` 指向有效的 Python 3 可执行文件；本轮使用随应用环境提供的 bundled runtime。

## 交付边界

数据大屏链路已完成真实原生联调：服务端保存、上传、不可变版本与乐观发布，客户端原生层下载、摘要与清单校验、原子缓存、授权令牌和本地资源协议，界面提供版本预览、发布/回退、刷新及受控取数。独立模板与打包器不依赖公网资源，大屏容器浏览器用例 5/5、模板用例 4/4、真实 Tauri 大屏 7/7 已通过。原生结果覆盖未发布版本独立预览、普通角色精确取数与本地模块/CSS/JSON、缓存篡改修复、断网保留与恢复、发布切换/回退、注销令牌撤销和停用撤权。此前 0.1.0 Windows NSIS 安装包已构建成功；构建成功不代表安装、升级、卸载或生产签名发布矩阵已经通过。

0.1.1 起内置发布公钥，提供内网 → 公网 → GitHub 的更新回退，发布流程见 [跨平台发布说明](../deploy/github/README.md)。发现服务和自建公网更新源不会自动部署到远程主机。

旧版仍有更丰富的图表联动、样式属性和服务端内容版本历史；通报的本机保存记录不等同于服务端历史版本。报表记录维护只对带主键的直接单表结构化查询开放。看板对超出 JavaScript 安全精度的数值不做近似汇总，并会显示部分结果提示。当前页面上传限制为 50 MB，超大文件分块续传尚未实现。逐项实现范围和证据见 `test/results/client-plan-coverage.md`，正式签名发布流程见 [更新文档](./updates.md)。

## 0.1.1 跨平台发布

支持 Windows x64、macOS arm64、macOS x64 三种安装包，不捆绑 WebView 运行时。macOS 网络服务运行在当前用户的 LaunchAgent 中；退出客户端后保持运行，注销用户后停止。Mac 登录启动与 Windows 每机开机启动的生命周期不同。构建、签名、安装及卸载见 [部署说明](../deploy/github/README.md)。
