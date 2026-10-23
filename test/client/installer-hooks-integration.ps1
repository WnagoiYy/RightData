param([Parameter(Mandatory)][string]$Package)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') { throw 'Requires an ephemeral Windows Actions runner' }
$project = (Resolve-Path "$PSScriptRoot/../..").Path
$stage = Join-Path $project 'client/target/x86_64-pc-windows-msvc/release'
New-Item -ItemType Directory -Force $stage | Out-Null
& 7z.exe e -y (Resolve-Path $Package).Path 'client.exe' 'rightdata-network-service.exe' "-o$stage"
if ($LASTEXITCODE) { throw 'Signed binary extraction failed' }
foreach ($name in @('client.exe','rightdata-network-service.exe')) {
    if (!(Test-Path (Join-Path $stage $name))) { throw "Missing $name" }
}
# Rebundle verified released binaries to test current hooks without recompiling
# application code. This diagnostic package is never published.
Push-Location "$project/client"
try {
    & npm.cmd ci
    if ($LASTEXITCODE) { throw 'Dependency installation failed' }
    & node scripts/tauri.mjs bundle --ci --target x86_64-pc-windows-msvc --bundles nsis
    if ($LASTEXITCODE) { throw 'Diagnostic installer bundling failed' }
} finally { Pop-Location }
$packages = @(Get-ChildItem "$stage/bundle/nsis/*-setup.exe")
if ($packages.Count -ne 1) { throw 'Expected one diagnostic installer' }
& "$PSScriptRoot/installer-integration.ps1" -Package $packages[0].FullName
