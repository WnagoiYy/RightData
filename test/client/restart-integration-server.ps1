$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$sessionPath = Join-Path $projectRoot 'test/runtime/client-integration-session.json'
$session = Get-Content -LiteralPath $sessionPath -Raw | ConvertFrom-Json
$expectedRoot = Join-Path $projectRoot 'test/runtime/client-integration-'
$runtime = [System.IO.Path]::GetFullPath($session.runtime)
if (-not $runtime.StartsWith($expectedRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing to restart an unrecognized runtime.' }
$process = Get-Process -Id $session.pid -ErrorAction Stop
if ($process.Path -ne $session.executable) { throw 'The recorded process no longer matches the test server.' }
$port = ([uri]$session.address).Port
$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop
if ($listener.OwningProcess -ne $session.pid) { throw 'The test port is owned by another process.' }
Stop-Process -Id $process.Id
$process.WaitForExit(5000) | Out-Null
$env:RIGHTDATA_ADDRESS = "127.0.0.1:$port"
$env:RIGHTDATA_DATA_DIR = Join-Path $runtime 'data'
$env:RIGHTDATA_ADMIN_USERNAME = $session.username
$env:RIGHTDATA_ADMIN_PASSWORD = $session.password
$env:RIGHTDATA_COOKIE_SECURE = 'false'
$env:RIGHTDATA_DUCKDB_EXTENSION = Join-Path $projectRoot 'server/resource/duckdb/v2.0.0/windows_amd64_mingw/httpfs.duckdb_extension'
$newProcess = Start-Process -FilePath $session.executable -WorkingDirectory (Join-Path $projectRoot 'server') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime 'server.stdout.log') -RedirectStandardError (Join-Path $runtime 'server.stderr.log')
$session.pid = $newProcess.Id
$session | ConvertTo-Json | Set-Content -LiteralPath $sessionPath -Encoding utf8
Write-Output "Restarted only the isolated test server on port $port; PID $($newProcess.Id)."
