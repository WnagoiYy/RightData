param([int]$Port = 18003)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$serverExecutable = Join-Path $projectRoot 'server/bin/rightdata.exe'
if (-not (Test-Path -LiteralPath $serverExecutable)) { throw 'Build server/bin/rightdata.exe before running the client integration suite.' }
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { throw "Port $Port is already in use; no existing server was changed." }
$runtimeRoot = Join-Path $projectRoot ('test/runtime/client-integration-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runtimeRoot | Out-Null
$testPassword = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
$env:RIGHTDATA_ADDRESS = "127.0.0.1:$Port"
$env:RIGHTDATA_DATA_DIR = Join-Path $runtimeRoot 'data'
$env:RIGHTDATA_ADMIN_USERNAME = 'client-test'
$env:RIGHTDATA_ADMIN_PASSWORD = $testPassword
$env:RIGHTDATA_COOKIE_SECURE = 'false'
$env:RIGHTDATA_DUCKDB_EXTENSION = Join-Path $projectRoot 'server/resource/duckdb/v2.0.0/windows_amd64_mingw/httpfs.duckdb_extension'
$process = Start-Process -FilePath $serverExecutable -WorkingDirectory (Join-Path $projectRoot 'server') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeRoot 'server.stdout.log') -RedirectStandardError (Join-Path $runtimeRoot 'server.stderr.log')
$session = @{ pid = $process.Id; address = "http://127.0.0.1:$Port"; username = 'client-test'; password = $testPassword; runtime = $runtimeRoot; executable = $serverExecutable }
$sessionFile = Join-Path $projectRoot 'test/runtime/client-integration-session.json'
$session | ConvertTo-Json | Set-Content -LiteralPath $sessionFile -Encoding utf8
Write-Output "Isolated test server started on port $Port; PID $($process.Id)."
