# DuckDB 离线扩展

服务使用 DuckDB 2.0.0。Windows Go 驱动平台为 `windows_amd64_mingw`。
原生 AES-256-GCM 写入需要 `httpfs` 的 OpenSSL 加密实现，因此在启动时从本目录加载签名扩展。
服务不执行 `INSTALL`，关闭扩展自动安装、自动加载与常规数据库连接的外部访问。

重新准备资源：在项目中执行 `./deploy/scripts/prepare-duckdb.ps1`。
其他平台需要传入引擎 `PRAGMA platform` 对应的平台名，打包相应目录。
也可通过 `RIGHTDATA_DUCKDB_EXTENSION` 指定已经准备好的扩展绝对路径。

来源：<https://extensions.duckdb.org/v2.0.0/windows_amd64_mingw/httpfs.duckdb_extension.gz>

已验证文件 SHA-256：`f243c4fb236dac6b5722373cf2ff1b85c95d2ae59212986309e32cc0e8d59967`。

DuckDB 和 httpfs 的上游许可证为 MIT；参考 <https://github.com/duckdb/duckdb-httpfs>。
