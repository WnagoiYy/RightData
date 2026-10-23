param(
    [Parameter(Mandatory)][string]$Package,
    [Parameter(Mandatory)][string]$InstallDir
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Local installation testing requires an administrator terminal.'
}
$packagePath = (Resolve-Path -LiteralPath $Package).Path
$installDirectory = (Resolve-Path -LiteralPath $InstallDir).Path.TrimEnd('\')
$clientPath = Join-Path $installDirectory 'client.exe'
$servicePath = Join-Path $installDirectory 'rightdata-network-service.exe'
$existing = Get-CimInstance Win32_Service -Filter "Name='RightDataNetwork'"
if ($null -eq $existing -or -not $existing.PathName.StartsWith(('"' + $servicePath + '" '), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'This local upgrade test requires the existing RightData service at the selected installation directory.'
}
$originalStartMode = $existing.StartMode
$originalController = [regex]::Match($existing.PathName, '--controller-sid\s+(S-1-[0-9-]+)').Groups[1].Value
if (!$originalController) { throw 'Existing service controller SID is missing' }
$dataDirectory = Join-Path $env:ProgramData 'RightData/network'
$retained = @{}
foreach ($name in @('device.key', 'network.json')) {
    $path = Join-Path $dataDirectory $name
    if (Test-Path -LiteralPath $path) { $retained[$name] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash }
}
if (!$retained.ContainsKey('device.key')) { throw 'Existing device identity is missing' }
$rounds = @()
for ($round = 1; $round -le 2; $round++) {
    "Local overlay installation $round"
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $process = Start-Process -FilePath $packagePath -ArgumentList "/S /D=$installDirectory" -WindowStyle Hidden -PassThru
    [void]$process.Handle
    if (!$process.WaitForExit(120000)) { throw 'Local installer timed out; inspect the installer before retrying.' }
    if ($process.ExitCode -ne 0) {
        Get-Content -LiteralPath "$installDirectory/rightdata-install-error.log" -ErrorAction SilentlyContinue | Write-Output
        throw "Local installer failed with exit code $($process.ExitCode)"
    }
    $service = Get-Service RightDataNetwork
    try { $service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(30)) }
    finally { $service.Dispose() }
    $current = Get-CimInstance Win32_Service -Filter "Name='RightDataNetwork'"
    if ($current.StartMode -ne $originalStartMode -or $current.PathName -notlike "*--controller-sid $originalController*") { throw 'Upgrade changed startup preference or controller' }
    foreach ($name in $retained.Keys) {
        if ((Get-FileHash -LiteralPath (Join-Path $dataDirectory $name) -Algorithm SHA256).Hash -ne $retained[$name]) { throw "Upgrade changed $name" }
    }
    $rounds += [pscustomobject]@{ round=$round; exitCode=$process.ExitCode; seconds=[math]::Round($timer.Elapsed.TotalSeconds,2); service=$current.State; retainedData=$true }
}
Stop-Service RightDataNetwork
Start-Service RightDataNetwork
$service = Get-Service RightDataNetwork
try { $service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(30)) }
finally { $service.Dispose() }
$client = Start-Process -FilePath $clientPath -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 5
if ($client.HasExited) { throw 'Installed client exited during startup' }
$project = (Resolve-Path "$PSScriptRoot/../..").Path
$report = [pscustomobject]@{
    package=$packagePath; sha256=(Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash
    version=(Get-Item -LiteralPath $clientPath).VersionInfo.ProductVersion
    installDirectory=$installDirectory; rounds=$rounds; serviceRestart=$true; clientProcessId=$client.Id
    verifiedAt=[DateTime]::UtcNow.ToString('o')
}
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$project/test/results/local-installer-verification.json" -Encoding UTF8
$report | ConvertTo-Json -Depth 5
