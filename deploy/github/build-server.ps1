param([switch]$SkipTests)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path "$PSScriptRoot/../..").Path
$version = (Get-Content "$project/client/package.json" -Raw | ConvertFrom-Json).version
$stage = "$project/test/build/server-$version"
New-Item -ItemType Directory -Force -Path $stage, "$project/test/artifacts/release" | Out-Null
if (-not $SkipTests) {
    & "$project/deploy/scripts/prepare-duckdb.ps1"
    & "$project/deploy/scripts/test-server.ps1"
} else {
    Push-Location "$project/server"
    try { go build -trimpath -o bin/rightdata.exe .; if ($LASTEXITCODE) { throw 'Build failed' } } finally { Pop-Location }
}
Copy-Item -LiteralPath "$project/server/bin/rightdata.exe" -Destination $stage
Copy-Item -LiteralPath "$project/server/resource" -Destination "$stage/resource" -Recurse -Force
$compiler = Split-Path (Get-Command gcc -ErrorAction Stop).Source
foreach ($dll in @('libgcc_s_seh-1.dll','libstdc++-6.dll','libwinpthread-1.dll')) {
    if (Test-Path "$compiler/$dll") { Copy-Item -LiteralPath "$compiler/$dll" -Destination $stage }
}
[IO.File]::WriteAllText("$stage/build.json", (@{version=$version; commit=$env:GITHUB_SHA; address='0.0.0.0:8003'} | ConvertTo-Json))
$archive = "$project/test/artifacts/release/RightDataServer-$version-windows-x64.zip"
Compress-Archive -Path "$stage/*" -DestinationPath $archive -Force
node "$project/deploy/github/sign-server.mjs" $archive
if ($LASTEXITCODE) { throw 'Signing failed' }
