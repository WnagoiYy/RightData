param([string]$Root='C:\ProgramData\RightDataServer', [string]$NodePath='D:\tools\node\node.exe')
$ErrorActionPreference = 'Stop'
if ([IO.Path]::GetFullPath($Root).TrimEnd('\') -ne 'C:\ProgramData\RightDataServer') { throw 'Unexpected deployment root' }
New-Item -ItemType Directory -Path $Root -Force | Out-Null
& icacls.exe $Root /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE) { throw 'Cannot restrict deployment ACL' }
foreach ($directory in @('tools','releases','downloads','logs','backups','data')) { New-Item -ItemType Directory -Path "$Root/$directory" -Force | Out-Null }
if (-not (Test-Path "$Root/config.json")) {
    # GoFrame needs a config source even when deployment values use environment variables.
    [IO.File]::WriteAllText("$Root/config.json", '{}')
}
if (-not (Test-Path "$Root/tools/node.exe")) { Copy-Item -LiteralPath $NodePath -Destination "$Root/tools/node.exe" }
if (-not (Test-Path "$Root/credentials.json")) {
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $key = New-Object byte[] 32; $password = New-Object byte[] 24
    $rng.GetBytes($key); $rng.GetBytes($password); $rng.Dispose()
    [IO.File]::WriteAllText("$Root/credentials.json", (@{username='admin'; password=[Convert]::ToBase64String($password); masterKey=[Convert]::ToBase64String($key)} | ConvertTo-Json))
}
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$serverAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$Root/run-server.ps1`"" -WorkingDirectory $Root
$serverSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'RightData-Server' -Action $serverAction -Principal $principal -Settings $serverSettings -Trigger (New-ScheduledTaskTrigger -AtStartup) -Force | Out-Null
if (-not (Get-NetFirewallRule -Name 'RightData-Server-8003' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name 'RightData-Server-8003' -DisplayName 'RightData server TCP 8003' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8003 -Profile Any -RemoteAddress LocalSubnet | Out-Null
}
Write-Output 'RightData startup task and LAN firewall rule installed; deployments use SSH only.'
