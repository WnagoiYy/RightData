param([switch]$Race)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$serverRoot = Join-Path $projectRoot 'server'
$testRoot = Join-Path $projectRoot 'test/server'
$previousEnvironment = @{}
foreach ($name in @('GOTMPDIR', 'TMP', 'TEMP', 'TMPDIR')) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
try {
    $env:GOTMPDIR = Join-Path $projectRoot 'test/runtime/go-build'
    New-Item -ItemType Directory -Force -Path $env:GOTMPDIR | Out-Null
    $env:TMP = Join-Path $projectRoot 'test/runtime'
    $env:TEMP = $env:TMP
    $env:TMPDIR = $env:TMP
    Push-Location $serverRoot
    try {
        go vet ./...
        if ($LASTEXITCODE -ne 0) { throw 'Server vet failed.' }
        go build -o bin/rightdata.exe .
        if ($LASTEXITCODE -ne 0) { throw 'Server build failed.' }
    } finally { Pop-Location }
    Push-Location $testRoot
    try {
        $testArguments = @('test', '-count=1', '-timeout=10m')
        if ($Race) { $testArguments += '-race' }
        $testArguments += './...'
        & go @testArguments
        if ($LASTEXITCODE -ne 0) { throw 'Server integration tests failed.' }
    } finally { Pop-Location }
} finally {
    foreach ($name in $previousEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
    }
}
