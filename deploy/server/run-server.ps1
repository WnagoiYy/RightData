$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$active = Get-Content "$root/current.json" -Raw | ConvertFrom-Json
if ($active.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid active version' }
$release = "$root/releases/$($active.version)"
$secret = Get-Content "$root/credentials.json" -Raw | ConvertFrom-Json
$env:RIGHTDATA_ADDRESS = '0.0.0.0:8003'
$env:RIGHTDATA_DATA_DIR = "$root/data"
$env:RIGHTDATA_MASTER_KEY = $secret.masterKey
$env:RIGHTDATA_ADMIN_USERNAME = $secret.username
$env:RIGHTDATA_ADMIN_PASSWORD = $secret.password
$env:RIGHTDATA_DUCKDB_EXTENSION = "$release/resource/duckdb/v2.0.0/windows_amd64_mingw/httpfs.duckdb_extension"
$env:RIGHTDATA_COOKIE_SECURE = 'true'
Set-Location $release
& "$release/rightdata.exe" >> "$root/logs/server.log" 2>&1
exit $LASTEXITCODE
