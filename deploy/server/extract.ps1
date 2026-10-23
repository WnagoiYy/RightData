param([Parameter(Mandatory)][string]$Archive, [Parameter(Mandatory)][string]$Destination)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PSScriptRoot)
if ($root -ne 'C:\ProgramData\RightDataServer' -or ![IO.Path]::GetFullPath($Archive).StartsWith("$root\downloads\", [StringComparison]::OrdinalIgnoreCase) -or ![IO.Path]::GetFullPath($Destination).StartsWith("$root\releases\", [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid extraction paths' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($Archive)
try {
    foreach ($entry in $zip.Entries) {
        $target = [IO.Path]::GetFullPath((Join-Path $Destination $entry.FullName))
        if (!$target.StartsWith([IO.Path]::GetFullPath($Destination).TrimEnd('\')+'\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe archive entry' }
    }
} finally { $zip.Dispose() }
Expand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force
