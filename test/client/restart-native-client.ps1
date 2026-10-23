param([string]$SourceExecutable)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$sessionPath = Join-Path $projectRoot 'test/runtime/client-native-session.json'
$session = Get-Content -LiteralPath $sessionPath -Raw | ConvertFrom-Json
$runtime = [System.IO.Path]::GetFullPath($session.runtime)
$allowedPrefix = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'test/runtime/client-native-'))
if (-not $runtime.StartsWith($allowedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected native test runtime path.' }
$binary = [System.IO.Path]::GetFullPath($session.executable)
if ($binary -ne (Join-Path $runtime 'client.exe')) { throw 'Unexpected native test executable.' }
$running = Get-Process -Id $session.pid -ErrorAction SilentlyContinue
if ($running) {
  if ($running.Path -ne $binary) { throw 'Native test PID now belongs to another executable.' }
  Stop-Process -Id $running.Id
  $running.WaitForExit(10000) | Out-Null
}
for ($attempt = 0; $attempt -lt 50; $attempt++) {
  if (-not (Get-NetTCPConnection -LocalPort $session.port -State Listen -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 100
}
if (Get-NetTCPConnection -LocalPort $session.port -State Listen -ErrorAction SilentlyContinue) { throw 'Native test debug port is still occupied.' }
if ($SourceExecutable) {
  $source = (Resolve-Path -LiteralPath $SourceExecutable).Path
  $allowedSource = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'test/runtime/client-native/bin/'))
  if (-not $source.StartsWith($allowedSource, [System.StringComparison]::OrdinalIgnoreCase) -or [System.IO.Path]::GetExtension($source) -ne '.exe') { throw 'Unexpected replacement test executable.' }
  Copy-Item -LiteralPath $source -Destination $binary -Force
}
$env:RIGHTDATA_NETWORK_PIPE = $session.pipe
$env:RIGHTDATA_CLIENT_DATA_DIR = Join-Path $runtime 'state'
$env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $runtime 'webview'
$env:RIGHTDATA_TEST_DEBUG_PORT = [string]$session.port
$process = Start-Process -FilePath $binary -WorkingDirectory (Join-Path $projectRoot 'client') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime 'client-restart.stdout.log') -RedirectStandardError (Join-Path $runtime 'client-restart.stderr.log')
$session.pid = $process.Id
$session | ConvertTo-Json | Set-Content -LiteralPath $sessionPath -Encoding utf8
Write-Output "Isolated native client restarted; PID $($process.Id)."
