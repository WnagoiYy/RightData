param(
    [string]$EngineVersion = 'v2.0.0',
    [string]$Platform = 'windows_amd64_mingw'
)
$ErrorActionPreference = 'Stop'
if ($EngineVersion -notmatch '^v\d+\.\d+\.\d+$' -or $Platform -notmatch '^[a-z0-9_]+$') {
    throw 'Invalid DuckDB version or platform.'
}
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$resourceRoot = Join-Path $projectRoot 'server/resource/duckdb'
$targetDirectory = Join-Path (Join-Path $resourceRoot $EngineVersion) $Platform
New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
$archivePath = Join-Path $targetDirectory 'httpfs.duckdb_extension.gz'
$extensionPath = Join-Path $targetDirectory 'httpfs.duckdb_extension'
$downloadUri = "https://extensions.duckdb.org/$EngineVersion/$Platform/httpfs.duckdb_extension.gz"
Invoke-WebRequest -Uri $downloadUri -OutFile $archivePath
$inputStream = $null
$gzipStream = $null
$outputStream = $null
try {
    $inputStream = [IO.File]::OpenRead($archivePath)
    $gzipStream = [IO.Compression.GZipStream]::new($inputStream, [IO.Compression.CompressionMode]::Decompress)
    $outputStream = [IO.File]::Create($extensionPath)
    $gzipStream.CopyTo($outputStream)
} finally {
    if ($outputStream) { $outputStream.Dispose() }
    if ($gzipStream) { $gzipStream.Dispose() }
    if ($inputStream) { $inputStream.Dispose() }
}
$hash = (Get-FileHash -LiteralPath $extensionPath -Algorithm SHA256).Hash
if ($EngineVersion -eq 'v2.0.0' -and $Platform -eq 'windows_amd64_mingw' -and $hash -ne 'F243C4FB236DAC6B5722373CF2FF1B85C95D2AE59212986309E32CC0E8D59967') {
    throw 'DuckDB extension checksum does not match the pinned artifact.'
}
Remove-Item -LiteralPath $archivePath
Write-Output "Prepared $EngineVersion / $Platform; SHA256 $hash"
