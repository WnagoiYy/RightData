[CmdletBinding()]
param(
    [string]$Target = 'x86_64-pc-windows-msvc'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$clientDir = Join-Path $projectRoot 'client'
$tauriConfigPath = Join-Path $clientDir 'src-tauri\tauri.conf.json'
$hooksPath = Join-Path $PSScriptRoot 'installer-hooks.nsh'

$serviceExecutable = & (Join-Path $PSScriptRoot 'build-network-service.ps1') `
    -Profile Release `
    -Target $Target
if (-not (Test-Path -LiteralPath $serviceExecutable -PathType Leaf)) {
    throw 'The packaged network service executable is missing.'
}

$tauriConfig = Get-Content -LiteralPath $tauriConfigPath -Raw | ConvertFrom-Json
if ($tauriConfig.bundle.windows.nsis.installMode -ne 'perMachine') {
    throw 'The Windows installer must use the perMachine install mode.'
}

$configuredHooks = [IO.Path]::GetFullPath(
    (Join-Path (Split-Path $tauriConfigPath -Parent) $tauriConfig.bundle.windows.nsis.installerHooks)
)
if ($configuredHooks -ne [IO.Path]::GetFullPath($hooksPath)) {
    throw 'tauri.conf.json does not reference deploy/windows/installer-hooks.nsh.'
}

$installedServiceResource = $tauriConfig.bundle.resources.PSObject.Properties |
    Where-Object { $_.Value -eq 'rightdata-network-service.exe' } |
    Select-Object -First 1
if ($null -eq $installedServiceResource) {
    throw 'tauri.conf.json does not install rightdata-network-service.exe as a bundle resource.'
}

$previousCargoTargetDir = [Environment]::GetEnvironmentVariable('CARGO_TARGET_DIR', 'Process')
[Environment]::SetEnvironmentVariable(
    'CARGO_TARGET_DIR',
    (Join-Path $clientDir 'target'),
    'Process'
)
Push-Location $clientDir
try {
    & npm.cmd run tauri -- build --bundles nsis --target $Target
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri NSIS packaging failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
    [Environment]::SetEnvironmentVariable(
        'CARGO_TARGET_DIR',
        $previousCargoTargetDir,
        'Process'
    )
}
