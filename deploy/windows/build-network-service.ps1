[CmdletBinding()]
param(
    [ValidateSet('Release', 'Debug')]
    [string]$Profile = 'Release',

    [string]$Target = 'x86_64-pc-windows-msvc'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$manifestPath = Join-Path $projectRoot 'client\network-service\Cargo.toml'
$targetDir = Join-Path $projectRoot 'client\target'

if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Network service manifest not found: $manifestPath"
}

$cargoArguments = @(
    'build',
    '--locked',
    '--manifest-path', $manifestPath,
    '--target-dir', $targetDir,
    '--target', $Target
)
if ($Profile -eq 'Release') {
    $cargoArguments += '--release'
}

& cargo @cargoArguments
if ($LASTEXITCODE -ne 0) {
    throw "Network service build failed with exit code $LASTEXITCODE."
}

$profileDirectory = $Profile.ToLowerInvariant()
$executablePath = Join-Path $targetDir "$Target\$profileDirectory\rightdata-network-service.exe"
if (-not (Test-Path -LiteralPath $executablePath -PathType Leaf)) {
    throw "Network service build did not produce: $executablePath"
}

$executablePath
