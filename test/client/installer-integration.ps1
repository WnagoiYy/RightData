param([Parameter(Mandatory)][string]$Package)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'This destructive installation lifecycle test only runs on an ephemeral Windows Actions runner.'
}
if (Get-Service RightDataNetwork -ErrorAction SilentlyContinue) { throw 'Runner already has a RightData service' }
$packagePath = (Resolve-Path $Package).Path
$project = (Resolve-Path "$PSScriptRoot/../..").Path
$installDirectory = Join-Path $project 'test/runtime/installed-client'
$dataDirectory = Join-Path $env:ProgramData 'RightData/network'
function Invoke-Installer([string]$Executable, [string]$Arguments) {
    $process = Start-Process -FilePath $Executable -ArgumentList $Arguments -WindowStyle Hidden -PassThru
    [void]$process.Handle
    if (-not $process.WaitForExit(120000)) {
        Stop-Process -Id $process.Id -Force
        Get-ChildItem -LiteralPath $installDirectory -ErrorAction SilentlyContinue | Select-Object Name,Length | Format-Table | Out-String | Write-Output
        Get-CimInstance Win32_Service -Filter "Name='RightDataNetwork'" | Select-Object Name,State,StartName,PathName | ConvertTo-Json | Write-Output
        if (Test-Path (Join-Path $installDirectory 'rightdata-network-service.exe')) {
            # Surface the exact failing lifecycle operation after a silent NSIS error
            # dialog. The original installer failure is still fatal to this test.
            & "$env:SystemRoot/SysWOW64/WindowsPowerShell/v1.0/powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$project/deploy/windows/service-lifecycle.ps1" -Action PostInstall -InstallDir $installDirectory
        }
        throw 'Installer timed out; no interactive dialogs are accepted in CI'
    }
    if ($process.ExitCode -ne 0) { throw "Installer exited $($process.ExitCode)" }
}
function Assert-Running {
    $service = Get-Service RightDataNetwork -ErrorAction Stop
    try { $service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(30)) }
    finally { $service.Dispose() }
    $imagePath = (Get-ItemProperty 'HKLM:/SYSTEM/CurrentControlSet/Services/RightDataNetwork').ImagePath
    $expected = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($imagePath -notlike "*--controller-sid $expected*") { throw 'Installed service is bound to the wrong Windows user' }
}
"Installer process session: $([Diagnostics.Process]::GetCurrentProcess().SessionId)"
"Installer test administrator: $([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))"
& "$env:SystemRoot/SysWOW64/WindowsPowerShell/v1.0/powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$project/test/client/installer-session.ps1" -Live
if ($LASTEXITCODE) { throw 'Real 32-bit session lookup failed before installation' }
'First install'
Invoke-Installer $packagePath "/S /D=$installDirectory"
Assert-Running
for ($attempt=0; $attempt -lt 30 -and !(Test-Path "$dataDirectory/device.key"); $attempt++) { Start-Sleep -Seconds 1 }
$identity = (Get-FileHash "$dataDirectory/device.key" -Algorithm SHA256).Hash
Set-Service RightDataNetwork -StartupType Automatic
'Overlay install'
Invoke-Installer $packagePath "/S /D=$installDirectory"
Assert-Running
if ((Get-FileHash "$dataDirectory/device.key" -Algorithm SHA256).Hash -ne $identity) { throw 'Upgrade changed device identity' }
if ((Get-CimInstance Win32_Service -Filter "Name='RightDataNetwork'").StartMode -ne 'Auto') { throw 'Upgrade changed startup preference' }
Stop-Service RightDataNetwork
Start-Service RightDataNetwork
Assert-Running
'Uninstall'
Invoke-Installer (Join-Path $installDirectory 'uninstall.exe') '/S'
for ($attempt=0; $attempt -lt 30 -and ((Get-Service RightDataNetwork -ErrorAction SilentlyContinue) -or (Test-Path "$installDirectory/client.exe")); $attempt++) { Start-Sleep -Seconds 1 }
if (Get-Service RightDataNetwork -ErrorAction SilentlyContinue) { throw 'Uninstall retained SCM registration' }
if ((Get-FileHash "$dataDirectory/device.key" -Algorithm SHA256).Hash -ne $identity) { throw 'Uninstall deleted retained data' }
'Reinstall'
Invoke-Installer $packagePath "/S /D=$installDirectory"
Assert-Running
if ((Get-FileHash "$dataDirectory/device.key" -Algorithm SHA256).Hash -ne $identity) { throw 'Reinstall changed retained identity' }
'NSIS first install, upgrade, service restart, uninstall and reinstall passed; controller SID, startup preference and device identity verified.'
