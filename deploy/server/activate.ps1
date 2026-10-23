param([Parameter(Mandatory)][string]$Version)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
if ([IO.Path]::GetFullPath($root) -ne 'C:\ProgramData\RightDataServer') { throw 'Unexpected deployment root' }
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid version' }
$candidate = "$root/releases/$Version"
if (-not (Test-Path -LiteralPath "$candidate/rightdata.exe")) { throw 'Missing executable' }
$previous = if (Test-Path "$root/current.json") { Get-Content "$root/current.json" -Raw } else { $null }
$expected = $null
try { $expected = (Invoke-RestMethod -TimeoutSec 5 http://127.0.0.1:8003/api/v1/probe).data.instanceId } catch {}
function Stop-Backend {
    Stop-ScheduledTask -TaskName 'RightData-Server' -ErrorAction SilentlyContinue
    $prefix = [IO.Path]::GetFullPath("$root/releases/")
    Get-CimInstance Win32_Process -Filter "Name='rightdata.exe'" | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
    } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop }
    Start-Sleep -Seconds 2
}
function Wait-Backend {
    for ($attempt=0; $attempt -lt 40; $attempt++) {
        Start-Sleep -Seconds 2
        try {
            $probe = (Invoke-RestMethod -TimeoutSec 3 http://127.0.0.1:8003/api/v1/probe).data
            if ($probe.service -eq 'rightdata' -and $probe.ready -and (!$expected -or $probe.instanceId -eq $expected)) { return $probe }
        } catch {}
    }
    throw 'Backend health check failed'
}
Stop-Backend
$backup = $null
$backupComplete = $false
try {
    if ($previous -and (Test-Path "$root/data")) {
        $backup = "$root/backups/$(Get-Date -Format yyyyMMdd-HHmmss)-$([guid]::NewGuid().ToString('N'))"
        Copy-Item -LiteralPath "$root/data" -Destination $backup -Recurse
        $backupComplete = $true
    }
    [IO.File]::WriteAllText("$root/current.json", (@{version=$Version} | ConvertTo-Json))
    Start-ScheduledTask -TaskName 'RightData-Server'
    $probe = Wait-Backend
    @{version=$Version; instanceId=$probe.instanceId; ready=$true; checkedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress
} catch {
    Stop-Backend
    if ($previous) {
        if ($backupComplete) {
            # Retain the failed candidate data for diagnosis; restore the quiesced snapshot.
            Move-Item -LiteralPath "$root/data" -Destination "$root/backups/failed-$([guid]::NewGuid().ToString('N'))"
            Copy-Item -LiteralPath $backup -Destination "$root/data" -Recurse
        }
        [IO.File]::WriteAllText("$root/current.json", $previous)
        Start-ScheduledTask -TaskName 'RightData-Server'
        $null = Wait-Backend
    }
    throw
}
