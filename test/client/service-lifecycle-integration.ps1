param([Parameter(Mandatory)][string]$Package)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') { throw 'Requires an ephemeral Windows Actions runner' }
if (Get-Service RightDataNetwork -ErrorAction SilentlyContinue) { throw 'Existing service on runner' }
$project = (Resolve-Path "$PSScriptRoot/../..").Path
# Intentionally exercise quoted installation paths, as used under Program Files.
$stage = Join-Path $project 'test/runtime/service-lifecycle/Program Files'
New-Item -ItemType Directory -Force $stage | Out-Null
& 7z.exe e -y (Resolve-Path $Package).Path 'rightdata-network-service.exe' "-o$stage"
if ($LASTEXITCODE -ne 0 -or !(Test-Path "$stage/rightdata-network-service.exe")) { throw 'Service extraction failed' }
function Lifecycle([string]$Action) {
    & "$env:SystemRoot/SysWOW64/WindowsPowerShell/v1.0/powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$project/deploy/windows/service-lifecycle.ps1" -Action $Action -InstallDir $stage
    if ($LASTEXITCODE) { throw "$Action failed in 32-bit PowerShell" }
}
Lifecycle PostInstall
$service = Get-CimInstance Win32_Service -Filter "Name='RightDataNetwork'"
if ($service.State -ne 'Running' -or $service.PathName -notlike ('"' + $stage + '\rightdata-network-service.exe"*')) { throw 'Service image path quoting or startup failed' }
Set-Service RightDataNetwork -StartupType Automatic
Lifecycle PreInstall
Lifecycle PostInstall
if ((Get-CimInstance Win32_Service -Filter "Name='RightDataNetwork'").StartMode -ne 'Auto') { throw 'Startup preference changed' }
Lifecycle Uninstall
if (Get-Service RightDataNetwork -ErrorAction SilentlyContinue) { throw 'Service was not removed' }
'Actual SCM registration, quoted paths, service ACL, firewall, start, upgrade preservation and removal passed in 32-bit PowerShell.'
