# 数据大屏静态包协议 v1

状态：接口契约冻结，服务端实现已合入，38 项全量竞态回归通过；使用 18004 独立实例联调，尚未部署到原有 8003/18003。所有 JSON 响应继续使用现有 code/data/requestId 信封，业务认证继续使用 Bearer Token。

## 资源与权限

共享配置增加 `kind=screen`，保存、草稿、乐观版本及查询绑定复用 `/api/v1/configs`。`body` 的 `enabled`、`permissions`、`definitionIds` 与其他资源相同，菜单使用 `resourceKind=screen`。

版本上传、管理列表、发布与回退要求 `config.write`，不要求 `files.read`/`files.write`。普通查看、下载和执行均要求 `resources.read`，并重新检查当前启用资源、菜单及所有祖先、资源权限；下载还要求所取版本是当前发布版本。配置人员可下载任意已上传版本以进行预览。

未发布的大屏不出现在普通菜单中，普通资源查看返回 404 `screen_not_published`。资源被停用、移除或菜单撤权后，下载与取数立即受新状态限制。

## ZIP 格式

ZIP 根包含且只包含一个 `manifest.json`，例如：

```json
{"screenId":"sales-screen","version":"1.0.0","entry":"index.html","containerApiVersion":1,"files":[{"path":"index.html","size":123,"sha256":"64位小写十六进制摘要"}]}
```

- `screenId` 必须是已有 screen 配置 ID；`version` 为稳定 SemVer `x.y.z`；`containerApiVersion` 必须为数字 1。
- `entry` 必须是清单内 `.html` 或 `.htm` 文件。`files` 列举所有普通文件，排除 `manifest.json`；每项必须匹配 ZIP 内容的字节数及 SHA-256。
- 使用便于跨平台安全解包的相对路径：ASCII 字母、数字、`-`、`_`、`.` 和 `/`；长度不超过 240，深度不超过 16。拒绝绝对路径、反斜杠、空段、`.`/`..`、Windows 保留文件名、末尾点，以及不区分大小写的重复文件和文件/目录冲突。符号链接及其他特殊文件一律拒绝。
- 只接受未加密、单卷、非 ZIP64 的 Store/Deflate ZIP，不接受自解压前缀。包最多 50 MiB，且继续受实例上传限制；`files` 最多 2048 个普通文件（不含清单），全部 ZIP 条目含目录最多 4096 个。清单最多 1 MiB，每个文件最多 32 MiB，总展开内容最多 200 MiB，文件及整体压缩比最多 100。允许安全的零内容目录条目。
- 服务端验证清单、路径、大小、哈希及 ZIP 完整性，只保存原 ZIP，不执行或公开托管其中 HTML/JS，也不执行解包或构建脚本。
- 所有运行依赖应包含在包内。服务端无法用静态扫描证明任意 JavaScript 不访问网络；客户端容器必须阻断外部网络、原生系统能力及凭据访问，只提供经过资源权限检查的取数桥接。资源包不持有业务 Token。此限制也是客户端启用该协议的前提。

## 接口

### 上传版本

`POST /api/v1/screens/{id}/versions`，multipart 字段 `file` 为 ZIP。成功 `data` 为 ScreenVersion：

```json
{"screenId":"sales-screen","version":"1.0.0","entry":"index.html","containerApiVersion":1,"files":[],"sha256":"ZIP摘要","sizeBytes":456,"createdAt":"UTC RFC3339时间","downloadUrl":"/api/v1/screens/sales-screen/versions/1.0.0/download"}
```

上传只登记不可变版本，不发布。同 ID/版本且 ZIP 字节摘要完全相同时重试返回原版本；不同内容返回 409 `screen_version_exists`。改变内容应使用新版本。

### 管理列表

`GET /api/v1/screens/{id}/versions` 返回 `data={items:ScreenVersion[],publishedVersion:ScreenVersion|null,publishRevision:number,publishedAt:string|null}`。版本按 SemVer 从高到低排列，初次发布前 revision 为 0；可选 `limit` 默认 20、最大 100，`offset` 默认 0。

### 发布和回退

`POST /api/v1/screens/{id}/publish`，HTTP 请求头 `Idempotency-Key`，JSON `{"version":"1.0.0","expectedRevision":0}`。

成功返回 `data={publishedVersion:ScreenVersion,publishRevision:1,publishedAt:"..."}`。必须匹配管理列表中的当前 `publishRevision`，否则 409 `version_conflict`。发布已上传的较旧版本即回退；每次成功发布推进 revision。相同幂等键、相同请求返回原回执；更改内容返回 409 `idempotency_conflict`。版本文件与查询绑定不因此被重写。

### 普通查看与查询

`GET /api/v1/resources/{id}` 对 screen 保留原 SharedConfig 字段，并新增 `publishedVersion`、`publishRevision`、`publishedAt`。普通用户只会收到当前已发布且有访问权限的版本。报表、看板和 H5 的既有字段不变。

`POST /api/v1/resources/{id}/execute` 保持 `{"definitionId":"...","params":{}}`，每次检查当前资源绑定、定义权限及行列数据权限。

### 下载

`GET /api/v1/screens/{id}/versions/{version}/download` 返回 `application/zip`，提供 `Content-Length`、以 ZIP SHA-256 为值的 ETag、Range/If-Range。下载完成后客户端必须验证 ZIP 摘要、清单、路径、大小及容器兼容性，再原子切换缓存。

普通用户不能下载未发布或已被替换的历史版本。配置人员通过同一接口预览历史版本，无需普通文件权限。这里不返回磁盘路径，也不经客户端安装包的公网兜底源获取。
