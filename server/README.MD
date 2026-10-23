# RightData 服务端

基于 GoFrame 2.10.0 和 DuckDB 2.0.0 新开发的 HTTP 数据服务。依赖固定在 `go.mod` / `go.sum`；Go 最低版本为 1.24，本机验证使用 Go 1.26.2。

业务界面、Excel 解析和生成由客户端负责。服务端不依赖 Tauri 或 iroh，不信任中转进程声明的用户身份；客户端经直连或中转访问同一实例时使用相同业务会话。

## 启动

在 `server/` 目录运行 `go run .`。默认地址为 `http://127.0.0.1:8003`。匿名 `GET /api/probe` 只返回服务标识、稳定实例 ID、API 主版本和就绪状态。

首次启动自动创建 `data/system.duckdb`、启动凭据和管理员。可在首次启动前设置 `RIGHTDATA_ADMIN_USERNAME`、`RIGHTDATA_ADMIN_PASSWORD`，密码至少 12 个字符。未提供密码时生成随机密码，保护后保存在 `data/admin.credential`，不会打印到服务日志。本机管理员可读取初始凭据：

```powershell
$env:RIGHTDATA_PRINT_INITIAL_PASSWORD = '1'
go run .
Remove-Item Env:RIGHTDATA_PRINT_INITIAL_PASSWORD
```

已有实例不会因环境变量变化重置用户密码。首次登录后可通过客户端调用改密接口；上面的本机命令只用于取得初始密码。

Windows 启动凭据使用运行账户的 DPAPI 保护。Linux/macOS 必须通过秘密注入机制设置 `RIGHTDATA_MASTER_KEY`（32 字节随机密钥的 Base64 编码）；Windows 也可显式使用该机制。完整实例恢复须保留匹配的启动凭据与保护环境；单个数据库文件的外部打开只需要数据库密码。

原生加密写入需要签名 `httpfs` 扩展，已准备 Windows `v2.0.0/windows_amd64_mingw` 版本。重新准备资源运行 `../deploy/scripts/prepare-duckdb.ps1`。服务只加载本地扩展，不执行在线安装；可通过 `RIGHTDATA_DUCKDB_EXTENSION` 指定扩展绝对路径。发布时同时携带 `resource/duckdb/`，工作目录应为 `server/`。

## 配置

配置文件为 `manifest/config/config.yaml`，环境变量优先。

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `RIGHTDATA_ADDRESS` | `127.0.0.1:8003` | HTTP 监听地址 |
| `RIGHTDATA_DATA_DIR` | `data` | 实例数据目录 |
| `RIGHTDATA_QUERY_SECONDS` | `30` | 同步查询及写操作超时 |
| `RIGHTDATA_TASK_SECONDS` | `900` | 后台任务总时限 |
| `RIGHTDATA_MAX_UPLOAD_BYTES` | `52428800` | 单个上传文件大小 |
| `RIGHTDATA_MAX_RESULT_ROWS` | `10000` | 普通查询单页上限，不截断全量导出 |
| `RIGHTDATA_TASK_CONCURRENCY` | `2` | 同时执行的任务数 |
| `RIGHTDATA_REQUEST_CONCURRENCY` | `32` | 同时处理的 HTTP 请求数 |
| `RIGHTDATA_RESULT_TTL_SECONDS` | `86400` | 暂存与结果保留时间 |
| `RIGHTDATA_COOKIE_SECURE` | `true` | 文档 Cookie 的 Secure 属性 |

生产文档 Cookie 使用 HTTPS。仅本机 HTTP 文档联调可显式设 `RIGHTDATA_COOKIE_SECURE=false`；业务 API 使用 Bearer Token。内网监听可设为 `:8003`。这些是首轮可调默认值，未做现场规模容量验收。

每个打开的 DuckDB 实例限制为 2 个引擎线程、512 MiB 内存、1 GiB 临时空间；同一业务库操作串行，任务并发及队列另有限制。系统库连接池固定为 1，事件去重及最新报告比较更新依赖同一事务串行执行。多实例使用独立数据目录，同一系统库由操作系统文件锁保证单进程启动。

## 接口

所有路径位于 `/api` 下，业务接口使用 `/api/v1`。普通 JSON 响应为 `{"code":"ok","message":"","data":{},"requestId":"..."}`。失败使用真实 HTTP 状态和稳定错误码；`X-Request-ID` 关联响应与审计。上传为 multipart，下载为字节流。

| 能力 | 主要入口 |
| --- | --- |
| 认证 | `/api/v1/auth/login`、`refresh`、`logout`、`password`、`me` |
| 用户和授权 | `/api/v1/users`、`/{id}`、`/{userId}/grants` |
| 数据库运维 | `/api/v1/data-files`、`/{id}/password`、`/{id}/backups`、`/{id}/download` |
| 连接登记和解绑 | `/api/v1/connections`、`/{id}` |
| 可访问的数据集 | `/api/v1/datasets` |
| 表与字段 | `/api/v1/datasets/{datasetId}/tables`、`/{table}/schema` |
| 表结构事务 | `/api/v1/datasets/{datasetId}/schema:mutate` |
| 查询和记录事务 | `/api/v1/datasets/{datasetId}/tables/{table}/query`、`/records:mutate` |
| 受控 SQL | `/api/v1/datasets/{datasetId}/sql:query` |
| 共享配置和查询定义 | `/api/v1/configs`、`/{id}`、`/{id}/execute` |
| 动态菜单和资源 | `/api/v1/menus`、`/api/v1/resources/{id}`、`/{id}/execute`、`/api/v1/resources/preview` |
| 数据大屏版本 | `/api/v1/screens/{id}/versions`、`/{id}/publish`、`/{id}/versions/{version}/download` |
| 客户端更新 | `/api/v1/client-updates`、`/latest`、`/{id}/download`、`/{id}/disable` |
| 普通文件与导入暂存 | `/api/v1/files`、`/api/v1/uploads` |
| 后台任务 | `/api/v1/import-jobs`、`/api/v1/export-jobs`、`/api/v1/jobs/{id}` |
| 取消和结果下载 | `/api/v1/jobs/{id}/cancel`、`/{id}/download` |
| 运行详情和日志 | `/api/v1/health`、`logs`、`query-logs`、`client-events` |

完整请求字段以自动 OpenAPI 为准：`/api/swagger`、`/api/api.json`。Swagger JS/CSS 随二进制嵌入，页面、规范及静态资源均需 `docs.read`。长期 Token 不放进 URL。已登录客户端可申请 `POST /api/v1/auth/document-ticket`，然后以 `POST /api/docs/session {"ticket":"..."}` 换取仅用于文档的 HttpOnly Cookie。票据 60 秒有效且只能兑换一次，文档会话 10 分钟有效。业务 API 不接受该 Cookie，在线调试另用业务 Bearer Token；注销及撤权阻断后续访问。

Access Token 有效期 15 分钟；默认记住登录的恢复凭据为 30 天，不记住登录为 1 天。恢复时轮换 Access/Refresh Token，注销撤销服务器会话，权限每次请求重新读取。登录密码使用 PBKDF2-SHA256，Token 只存哈希。

`GET /api/v1/auth/me` 保持 `id`、`username`、`permissions`、`disabled` 平铺字段，并返回字符串 `authzRevision`。用户能力或表级行列授权变更都会推进这个实例级版本；客户端定时或窗口聚焦时发现版本变化，应清理旧业务展示并按当前权限重新取数。版本为全局值，其他用户授权变化也可能触发刷新；客户端只比较是否变化，不转为 JavaScript 数字。

## 权限与事务

全局能力包括 `data.read`、`data.write`、`data.export`、`schema.manage`、`sql.execute`、`datasets.manage`、`datasets.password`、`datasets.download`、`files.read`、`files.write`、`jobs.read`、`jobs.cancel`、`config.read`、`config.write`、`resources.read`、`docs.read`、`logs.read`、`users.manage`、`system.manage`。`*` 是实例管理员。

数据访问还需要数据集、表级授权，包含 `operations`（read/write/export/schema）、`columns` 和 `rowFilter`。每份授权的列与行范围保持绑定，不能拼接出更大权限；行筛选在聚合、排序和分页前生效，更新检查原记录与修改后记录。普通文件及数据库文件管理另校验归属，系统库及其备份需系统管理权限。查询权限不会授予完整库文件或密码。

记录写入、结构变更、共享配置保存及后台任务通过 HTTP 请求头 `Idempotency-Key` 传入幂等标识。业务写入与提交凭据同事务提交；同键同请求返回原结果，异体冲突返回 409。配置保存还需 `version`，初次为 0，后续携带读取版本。

共享配置支持 report/dashboard/h5/screen/query/settings/menu/role 类型的 JSON 文档。role 配置不会自动改变服务端授权；实际用户授权由用户管理接口维护。查询定义运行时仍校验调用者数据权限，定义保存不会授予 SQL 工作台权限。

受控 SQL 在词法解析阶段限制为 64 KiB、4096 个词法单元和 32 层括号嵌套，超限会在进入 DuckDB 前拒绝。语句过长返回 `413/sql_too_large`，词法单元或嵌套超限返回 `400/sql_too_complex`。

支持中文表和字段、显式类型、可空性、字面量默认值、主键与唯一键，以及建删表和受控字段结构变更。业务查询限定登记库的 `main` schema 和真实基础表，禁止内部表、视图和其他 catalog。值参数绑定，动态标识符校验并引用。

## 动态菜单与资源预览

报表、看板、H5 和大屏的 JSON 配置包含 `enabled`、`permissions`、`definitionIds`，其余布局字段由客户端定义。`permissions` 为全部必须具备的权限标识，可使用业务自定义权限；未设置 `enabled:true` 的资源视为草稿。查询定义也可指定 `permissions`，运行时再次校验。

每份 menu 配置对应一个菜单项，包含 `enabled`、`permissions`、`parentId`、`order`、`resourceId`、`resourceKind`；无资源绑定的项用作分组。普通用户需具备 `resources.read`，且资源与至少一个菜单绑定同时有效。服务端逐层校验祖先菜单，拒绝循环、缺失或停用的路径。取数只允许资源 `definitionIds` 中的查询，并继续执行查询定义与实际数据权限检查；每次请求重读当前状态。

`config.write` 是全局配置编辑和预览权限，可预览停用、未挂载或尚未保存的资源，但不会扩大数据权限。预览请求的 `body` 只在本次请求使用，不保存；省略 `body` 时按 `id` 预览已保存配置。普通资源查看者使用菜单及资源接口；原始配置列表需要 `config.read`，其中非 query 配置还需 `config.write`，避免通过配置列表绕过菜单访问限制。

例如，保存 query 配置时其 `body` 可为 `{"datasetId":"sales-db","sql":"SELECT region,SUM(amount) AS total FROM sales WHERE region=:region GROUP BY region","permissions":["sales.view"]}`。资源配置使用 `{"enabled":true,"permissions":["sales.view"],"definitionIds":["sales-query"],"layout":{}}`，菜单配置使用 `{"enabled":true,"resourceId":"sales-report","resourceKind":"report","order":1}`。运行时只提交绑定的 `definitionId` 和 `params`；客户端不能替换已保存 SQL。

## 数据大屏静态包

大屏使用 `kind=screen` 配置与相同的菜单、查询绑定及行列权限。以 `config.write` 上传含根清单 `manifest.json` 的成品 ZIP，服务验证完整性后保存不可变版本；上传不自动发布。同 ID、版本和 ZIP 字节的重试返回原版本，不同内容返回 409。发布或回退通过 `expectedRevision` 与 `Idempotency-Key` 在同一事务中提交。

普通用户只可查看和下载当前已发布且资源、菜单链均授权的版本；未发布资源不出现在普通菜单中。配置人员可下载历史版本进行预览，无需普通文件权限。下载支持 SHA-256 ETag、Range 和 If-Range。服务端只保存和分发 ZIP，不执行或托管其中脚本。

ZIP 最多 50 MiB（实例上传限制更低时取较低值），最多 2048 个业务文件、4096 个总条目，清单最多 1 MiB，单文件最多 32 MiB，展开总量最多 200 MiB，压缩比最多 100。拒绝路径穿越、大小写别名、特殊文件、加密、多卷、ZIP64、SFX、目录与本地头不一致以及清单或摘要不一致。超过 24 小时且没有版本记录引用的服务命名临时包和孤儿包按批清理；已登记的历史版本保留。

完整字段、路径约束和客户端容器责任见 [数据大屏协议 v1](docs/screen-v1.md)。客户端须校验并原子切换缓存，隔离页面网络、原生能力及凭据，只通过受控桥接取数；服务端静态校验不能证明任意脚本离线安全。

## 客户端更新分发

首版支持 `platform=windows`、`arch=x64` 和稳定的 `major.minor.patch` 版本号。发布者先上传自己的完整安装包，再以 `system.manage` 权限向 `POST /api/v1/client-updates` 提交 `fileId`、`version`、`signature`、`platform`、`arch`。服务将文件复制为独立、不可变的发布包，重新核验 SHA-256 与长度；同平台、架构和版本不可覆盖。

任意已登录用户可查询 `GET /api/v1/client-updates/latest?platform=windows&arch=x64&currentVersion=1.0.0`。有更新时返回包含版本、签名、SHA-256、长度及相对下载地址的 JSON 信封；无更新返回 **204 且无响应体**，客户端应把它视为内网查询成功，不触发公网回退。下载支持 ETag 和 Range，停用发布后不再提供下载。原普通文件被替换或删除不会改变已发布内容。

`signature` 由发布流程提供，服务端保存并分发；客户端仍须使用预置信任公钥验证签名及完整性。此服务不生成签名、不执行安装包，也不负责安装器或 Rust 网络服务的升级。本机测试只验证分发协议，未使用真实签名安装包做安装验收。

## 导入导出

客户端完成 Excel→CSV。CSV 为 UTF-8 无 BOM、逗号分隔、LF 换行、明确表头。未加引号的 `\N` 是 NULL，`"\N"` 是文本，`""` 是空字符串；严格解析引号内逗号、换行及双引号，文本不裁剪，大整数和 DECIMAL 不经浮点数。

除上传字节限制外，CSV 每条逻辑记录最多 1024 个字段，最多 250000 条逻辑记录、2000000 个单元格（含表头）；超限在写入前拒绝。

先向 `/api/v1/uploads` 上传 `purpose=import` 与文件，再提交上传 ID、数据集、表、列和模式：`append`、`replace_all`、`replace_where`、`merge`、`skip_existing`。按键操作指定键字段，批内重复或目标匹配不唯一会拒绝；空文件不能替换。条件替换当前支持单字段 `eq`。所有模式在同一事务内执行，成功才表示已提交，失败或取消不保留部分记录。

导出在一个快照内逐行读取，分块生成不可变 NDJSON。首记录给出字段与类型，行块带序号，末记录给出完成状态和行数；下载提供 ETag、长度和 HTTP Range。BIGINT/HUGEINT/DECIMAL 为十进制字符串，无时区时间戳保留日期时间语义。普通查询分页上限不限制导出。

客户端生成或保存导出文件后，以原任务所属用户的业务会话向 `POST /api/v1/client-events` 补报：

```json
{
  "eventId": "018f47d2-bb75-7b64-8f12-7bb36b975b62",
  "instanceId": "GET /api/probe 返回的 instanceId",
  "occurredAt": "2026-10-23T02:30:00.123+08:00",
  "category": "client_export",
  "action": "file_generation",
  "targetId": "导出任务 ID",
  "outcome": "success"
}
```

`eventId` 是客户端持久化的稳定 UUID；重试必须原样使用同一请求内容。`instanceId` 必须等于创建该任务的当前服务实例，`occurredAt` 使用 RFC 3339；服务端按同一时刻的 UTC RFC3339Nano 规范形式保存，并保留纳秒精度。`targetId` 必须是当前登录用户所有且 `kind=export` 的任务。补报只要求已登录及任务归属，不再次要求 `data.export` 或 `jobs.read`，因此任务完成后撤回业务权限不会阻断待发事件。`client_export` 只接受 `file_generation`；`relay` 只接受 `connect`、`disconnect`，且不要求导出任务。结果限 `success`、`failed`、`canceled`。

成功响应的 `data` 为 `{"eventId":"...","receivedAt":"...","applied":true}`。`receivedAt` 以 UTC 微秒精度持久化。同一用户以同一 `eventId` 重试同一内容时返回最初的完整确认，`receivedAt` 与 `applied` 都不改变，也不重复写审计；同一标识用于不同内容返回 HTTP 409。服务分别保存事件发生时间和接收时间。每个导出任务的 `file_generation` 最新报告先按 `occurredAt` 排序，同一发生时间由字典序较大的规范化 `eventId` 胜出；较旧事件仍获确认，但 `applied=false`，不会覆盖最新报告。

`GET /api/v1/jobs/{id}` 对导出任务返回 `clientReport`。尚无报告时其 `outcome` 为 `unknown`；收到报告后给出当前事件的 `eventId`、`stage`、`outcome`、`occurredAt`、`receivedAt`。该报告不修改服务端任务 `state`。具有 `logs.read` 的用户可通过 `GET /api/v1/client-events` 检索事件明细，包括 `eventId`、发生时间、接收时间及是否曾应用为最新报告。90 天审计清理只删除通用审计行，事件回执及最新客户端报告继续保留，后续重试仍返回原确认。客户端在收到确认前应把完整事件持久化；补报失败不改变已完成的导出或本地文件。

导入暂存不可替换，任务绑定内容哈希。下载再次检查数据权限和授权版本，任何授权变更都使旧导出保守失效，须重新创建。重启通过业务库提交记录核实任务，不自动重跑未知写入。已提交成功的操作不能再标记为取消。

备份使用 DuckDB 受控连接复制至新的原生加密库，校验后登记并沿用源库密码；在线库下载通过一致快照交付。运行中的系统库不可删除或上传覆盖。

受控快照仅写入实例数据目录的 `databases/snapshots/`。引擎禁用外部访问，并仅预先允许该快照目录；用户提交的查询不能调用文件函数或改变引擎设置。

## 当前边界

SQL 工作台当前支持单表 SELECT、字段投影、命名参数、布尔筛选、六类聚合、GROUP BY、ORDER BY、LIMIT/OFFSET。输入经词法、语法解析后转换为通用查询结构，用户 SQL 原文不送入引擎。不支持的语法、对象和函数明确拒绝。

任意 SQL、多语句、JOIN、CTE、子查询、窗口函数、SQL 写入及独立进程/OS 沙箱尚未实现，仍属原计划后续范围。数据库改密、整实例恢复和自动切换也尚无管理接口。

本轮未实施客户端、iroh、节点发现服务或远程部署；本机服务端测试不代替跨网验收。查询日志保存服务生成的 SQL 模板与来源，不保存参数值；中转和客户端文件生成事件明确为客户端补报。

## 验证

项目目录运行 `./deploy/scripts/test-server.ps1`，加 `-Race` 开启 Go race 检查。集成测试位于 `test/server/`，使用并清理 `test/runtime/` 下独立加密库。

已启动实例的本机冒烟检查：在 `server/` 执行 `go run ../test/smoke/main.go`。它读取本机初始凭据完成探测、登录、健康检查和注销，只打印状态。已修改初始密码的实例应通过客户端或自备安全凭据检查。

基线结果及未测试项见 `test/results/server-validation.md`；大屏协议合入后的 38 项全量竞态回归、独立联调实例和边界见 `test/results/server-screen-validation.md`。
