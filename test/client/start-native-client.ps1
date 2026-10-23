$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$binary = Join-Path $projectRoot 'test/runtime/client-native/bin/client.exe'
if (-not (Test-Path -LiteralPath $binary)) { throw 'Build the debug Tauri client first.' }
if (Get-NetTCPConnection -LocalPort 9225 -State Listen -ErrorAction SilentlyContinue) { throw 'Test debug port 9225 is already in use.' }
$runtime = Join-Path $projectRoot ('test/runtime/client-native-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runtime | Out-Null
$runtimeBinary = Join-Path $runtime 'client.exe'
Copy-Item -LiteralPath $binary -Destination $runtimeBinary
$backendSession = Get-Content -LiteralPath (Join-Path $projectRoot 'test/runtime/client-integration-session.json') -Raw | ConvertFrom-Json
$serviceSource = Join-Path $projectRoot 'test/build/network-service-check/x86_64-pc-windows-msvc/debug/rightdata-network-service.exe'
$serviceDirectory = Join-Path $runtime 'network'
New-Item -ItemType Directory -Path $serviceDirectory | Out-Null
$serviceBinary = Join-Path $serviceDirectory 'rightdata-network-service.exe'
Copy-Item -LiteralPath $serviceSource -Destination $serviceBinary
@{ serverUrl = $backendSession.address; allowPublicRelay = $false; enabled = $true } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $serviceDirectory 'network.json') -Encoding utf8NoBOM
$pipeName = 'rightdata-test-native-' + [guid]::NewGuid().ToString('N')
$env:RIGHTDATA_NETWORK_PIPE = '\\.\pipe\' + $pipeName
$serviceProcess = Start-Process -FilePath $serviceBinary -ArgumentList @('--data-dir', $serviceDirectory) -WorkingDirectory $serviceDirectory -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime 'network.stdout.log') -RedirectStandardError (Join-Path $runtime 'network.stderr.log')
$ready = $false
for ($attempt = 0; $attempt -lt 100; $attempt++) {
  $pipe = [System.IO.Pipes.NamedPipeClientStream]::new('.', $pipeName, [System.IO.Pipes.PipeDirection]::InOut)
  try { $pipe.Connect(100); $ready = $true; break } catch { Start-Sleep -Milliseconds 100 } finally { $pipe.Dispose() }
}
if (-not $ready) { throw 'Isolated network service did not create its control pipe.' }
$env:RIGHTDATA_CLIENT_DATA_DIR = Join-Path $runtime 'state'
$env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $runtime 'webview'
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9225'
$env:RIGHTDATA_TEST_DEBUG_PORT = '9225'
$process = Start-Process -FilePath $runtimeBinary -WorkingDirectory (Join-Path $projectRoot 'client') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime 'client.stdout.log') -RedirectStandardError (Join-Path $runtime 'client.stderr.log')
@{ pid = $process.Id; executable = $runtimeBinary; runtime = $runtime; port = 9225; servicePid = $serviceProcess.Id; serviceExecutable = $serviceBinary; pipe = $env:RIGHTDATA_NETWORK_PIPE } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $projectRoot 'test/runtime/client-native-session.json') -Encoding utf8
Write-Output "Isolated native client started; PID $($process.Id)."
